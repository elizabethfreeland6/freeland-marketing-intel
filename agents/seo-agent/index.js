import { ApifyClient } from 'apify-client'
import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'
import { DEALERSHIPS } from '../../lib/config.js'

const GSC_SITES = {
  chevrolet: process.env.GSC_SITE_URL_CHEVROLET,
  cdjr: process.env.GSC_SITE_URL_CDJR,
}

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
  return new google.auth.JWT({
    email: process.env.GSC_CLIENT_EMAIL,
    key: process.env.GSC_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  })
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
    const siteUrl = GSC_SITES[dealership.id]
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
    const run = await apify.actor('apify/lighthouse-scraper').call({
      startUrls: [{ url: dealership.url }],
      onlyFirstPage: true,
    })

    const { items } = await apify.dataset(run.defaultDatasetId).listItems()
    const item = items[0]
    if (!item) {
      console.log(`[${dealership.id}] Lighthouse: no result`)
      continue
    }

    const cats = item.lighthouseResult?.categories ?? {}
    const audits = item.lighthouseResult?.audits ?? {}

    const record = {
      dealership_id: dealership.id,
      url: dealership.url,
      performance_score: cats.performance?.score != null ? cats.performance.score * 100 : null,
      accessibility_score: cats.accessibility?.score != null ? cats.accessibility.score * 100 : null,
      best_practices_score: cats['best-practices']?.score != null ? cats['best-practices'].score * 100 : null,
      seo_score: cats.seo?.score != null ? cats.seo.score * 100 : null,
      lcp: audits['largest-contentful-paint']?.numericValue ?? null,
      fid: audits['max-potential-fid']?.numericValue ?? null,
      cls: audits['cumulative-layout-shift']?.numericValue ?? null,
      raw_json: item.lighthouseResult ?? null,
      captured_at: new Date().toISOString(),
      source: 'lighthouse',
    }

    const { error } = await supabase.from('site_audits').insert(record)
    if (error) throw new Error(`Lighthouse insert failed for ${dealership.id}: ${error.message}`)
    console.log(`[${dealership.id}] Lighthouse: perf=${record.performance_score}, seo=${record.seo_score}`)
  }
}

async function main() {
  console.log('SEO agent starting…')
  const supabase = makeSupabase()
  await runKeywordRankings(supabase)
  await runGSCPull(supabase)
  await runLighthouse(supabase)
  console.log('SEO agent done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
