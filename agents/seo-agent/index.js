import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') })

import { ApifyClient } from 'apify-client'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { DEALERSHIPS } from '../../lib/config.js'


function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function makeSupabase() {
  return createClient(
    process.env.MARKETING_SUPABASE_URL,
    process.env.MARKETING_SUPABASE_SERVICE_KEY
  )
}

function makeGSCAuth() {
  const client = new OAuth2Client(
    process.env.GA4_OAUTH_CLIENT_ID,
    process.env.GA4_OAUTH_CLIENT_SECRET
  )
  client.setCredentials({ refresh_token: process.env.GSC_OAUTH_REFRESH_TOKEN })
  return client
}

async function runKeywordRankings(supabase) {
  const apify = new ApifyClient({ token: process.env.APIFY_TOKEN })

  const { data: keywords } = await supabase
    .from('keywords')
    .select('id, dealership_id, keyword')
    .eq('active', true)

  if (!keywords?.length) {
    console.log('[seo] No active keywords found')
    return
  }

  // Group by dealership to minimize Apify actor runs
  const byDealership = {}
  for (const kw of keywords) {
    if (!byDealership[kw.dealership_id]) byDealership[kw.dealership_id] = []
    byDealership[kw.dealership_id].push(kw)
  }

  for (const dealership of DEALERSHIPS) {
    const kws = byDealership[dealership.id] ?? []
    if (!kws.length) continue

    const run = await apify.actor('apify/google-search-scraper').call({
      queries: kws.map((k) => k.keyword).join('\n'),
      maxPagesPerQuery: 1,
      resultsPerPage: 10,
      countryCode: 'us',
    })

    const { items } = await apify.dataset(run.defaultDatasetId).listItems()

    const records = []
    for (const item of items) {
      const kw = kws.find((k) => k.keyword.toLowerCase() === item.searchQuery?.term?.toLowerCase())
      if (!kw) continue

      const ourResult = item.organicResults?.find(
        (r) => r.url?.includes(dealership.url.replace('https://', '').replace('/', ''))
      )

      records.push({
        dealership_id: dealership.id,
        keyword_id: kw.id,
        keyword: kw.keyword,
        position: ourResult?.position ?? null,
        url: ourResult?.url ?? null,
        clicks: null,
        impressions: null,
        ctr: null,
        captured_at: new Date().toISOString(),
        source: 'apify-serp',
      })
    }

    if (records.length) {
      const { error } = await supabase.from('rankings_organic').insert(records)
      if (error) throw new Error(`SERP insert failed for ${dealership.id}: ${error.message}`)
    }
    console.log(`[${dealership.id}] SERP rankings: ${records.length} keywords tracked`)
  }
}

async function runGSCPull(supabase) {
  const auth = makeGSCAuth()
  const sc = google.searchconsole({ version: 'v1', auth })
  const endDate = daysAgo(1)
  const startDate = daysAgo(7)

  for (const dealership of DEALERSHIPS) {
    const siteUrl = dealership.gscProperty
    if (!siteUrl) continue

    const res = await sc.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query', 'page', 'device'],
        rowLimit: 1000,
      },
    })

    const records = (res.data.rows ?? []).map((row) => ({
      dealership_id: dealership.id,
      keyword_id: null,
      keyword: row.keys[0] ?? null,
      position: row.position ?? null,
      url: row.keys[1] ?? null,
      clicks: row.clicks ?? null,
      impressions: row.impressions ?? null,
      ctr: row.ctr ?? null,
      captured_at: new Date().toISOString(),
      source: 'gsc',
    }))

    if (records.length) {
      const { error } = await supabase.from('rankings_organic').insert(records)
      if (error) throw new Error(`GSC insert failed for ${dealership.id}: ${error.message}`)
    }
    console.log(`[${dealership.id}] GSC: ${records.length} rows for ${startDate} to ${endDate}`)
  }
}

async function runLighthouse(supabase) {
  const apify = new ApifyClient({ token: process.env.APIFY_TOKEN })

  for (const dealership of DEALERSHIPS) {
    const run = await apify.actor('constant_quadruped/lighthouse-auditor').call({
      url: dealership.url,
    })

    const { items } = await apify.dataset(run.defaultDatasetId).listItems()
    const item = items[0]
    if (!item) {
      console.log(`[${dealership.id}] Lighthouse: no result`)
      continue
    }

    const cwv = item.coreWebVitals ?? {}

    const record = {
      dealership_id: dealership.id,
      url: dealership.url,
      performance_score: item.performance ?? null,
      accessibility_score: item.accessibility ?? null,
      best_practices_score: item.bestPractices ?? null,
      seo_score: item.seo ?? null,
      lcp: cwv.LCP ?? null,
      fid: null,
      cls: cwv.CLS ?? null,
      raw_json: item,
      captured_at: new Date().toISOString(),
      source: 'lighthouse',
    }

    const { error } = await supabase.from('site_audits').insert(record)
    if (error) throw new Error(`Lighthouse insert failed for ${dealership.id}: ${error.message}`)
    console.log(`[${dealership.id}] Lighthouse: perf=${record.performance_score}, seo=${record.seo_score}`)
  }
}

async function runCTRAnalysis(supabase) {
  const since = daysAgo(30)

  // Aggregate GSC data by page over last 30 days
  const { data: rows, error } = await supabase
    .from('rankings_organic')
    .select('dealership_id, url, keyword, clicks, impressions, ctr')
    .eq('source', 'gsc')
    .gte('captured_at', since)

  if (error) {
    console.error('[ctr] query error:', error.message)
    return
  }

  // Aggregate by page
  const pages = {}
  for (const row of rows ?? []) {
    const key = `${row.dealership_id}|${row.url}`
    if (!pages[key]) pages[key] = { dealership_id: row.dealership_id, url: row.url, clicks: 0, impressions: 0, queries: {} }
    pages[key].clicks += row.clicks ?? 0
    pages[key].impressions += row.impressions ?? 0
    if (row.keyword) {
      pages[key].queries[row.keyword] = (pages[key].queries[row.keyword] ?? 0) + (row.clicks ?? 0)
    }
  }

  // Filter: >50 impressions, CTR < 2%
  const flagged = Object.values(pages).filter(
    (p) => p.impressions > 50 && (p.clicks / p.impressions) < 0.02,
  )

  if (!flagged.length) {
    console.log('[ctr] No underperforming pages found')
    return
  }

  const anthropic = new Anthropic()
  const suggestions = []

  for (const page of flagged) {
    const topQueries = Object.entries(page.queries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([q]) => q)

    const ctr = (page.clicks / page.impressions * 100).toFixed(1)
    console.log(`[ctr] Flagged: ${page.url} (${ctr}% CTR, ${page.impressions} impressions)`)

    if (!topQueries.length) continue

    let titleSuggestion = null
    let metaSuggestion = null

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Write an improved HTML page title and meta description for a car-buying landing page at ${page.url}. The page gets impressions for these search queries: ${topQueries.join(', ')}. Current CTR is only ${ctr}% — the goal is higher click-through from search results. Nashville, TN local business. No em dashes. Title under 60 chars, description under 160 chars. Reply with exactly two lines:\nTITLE: <title here>\nDESCRIPTION: <description here>`,
        }],
      })
      const text = msg.content[0]?.text ?? ''
      titleSuggestion = text.match(/^TITLE:\s*(.+)/m)?.[1]?.trim() ?? null
      metaSuggestion = text.match(/^DESCRIPTION:\s*(.+)/m)?.[1]?.trim() ?? null
    } catch (err) {
      console.error('[ctr] Claude error:', err.message)
    }

    suggestions.push({
      dealership_id: page.dealership_id,
      url: page.url,
      impressions: page.impressions,
      clicks: page.clicks,
      ctr_pct: parseFloat(ctr),
      top_queries: topQueries,
      suggested_title: titleSuggestion,
      suggested_description: metaSuggestion,
      flagged_at: new Date().toISOString(),
    })
  }

  if (suggestions.length) {
    const report = {
      type: 'ctr_analysis',
      week_of: new Date().toISOString().slice(0, 10),
      flagged_pages: suggestions,
    }
    const { error: insertErr } = await supabase.from('seo_ctr_flags').upsert(
      suggestions.map((s) => ({ ...s, week_of: report.week_of })),
      { onConflict: 'dealership_id,url,week_of', ignoreDuplicates: false },
    )
    if (insertErr) console.error('[ctr] insert error:', insertErr.message)
    console.log(`[ctr] ${suggestions.length} underperforming pages flagged and stored`)
  }
}

async function main() {
  console.log('SEO agent starting…')
  const supabase = makeSupabase()
  await runKeywordRankings(supabase)
  await runGSCPull(supabase)
  await runLighthouse(supabase)
  await runCTRAnalysis(supabase)
  console.log('SEO agent done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
