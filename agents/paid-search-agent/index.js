import { GoogleAdsApi } from 'google-ads-api'
import { createClient } from '@supabase/supabase-js'
import { DEALERSHIPS } from '../../lib/config.js'

const CUSTOMER_IDS = {
  chevrolet: process.env.GOOGLE_ADS_CUSTOMER_ID_CHEVROLET,
  cdjr: process.env.GOOGLE_ADS_CUSTOMER_ID_CDJR,
}

function yesterday() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

function makeAdsClient() {
  return new GoogleAdsApi({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  })
}

function makeSupabase() {
  return createClient(
    process.env.MARKETING_SUPABASE_URL,
    process.env.MARKETING_SUPABASE_SERVICE_KEY
  )
}

async function pullDealership(adsClient, supabase, dealership) {
  const customerId = CUSTOMER_IDS[dealership.id]
  if (!customerId) throw new Error(`No Google Ads customer ID for ${dealership.id}`)

  const customer = adsClient.Customer({
    customer_id: customerId,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  })

  const date = yesterday()

  const rows = await customer.query(`
    SELECT
      campaign.name,
      ad_group.name,
      ad_group_criterion.keyword.text,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.average_cpc,
      metrics.conversions,
      metrics.conversions_value,
      ad_group_criterion.quality_info.quality_score
    FROM keyword_view
    WHERE segments.date = '${date}'
      AND campaign.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
      AND ad_group_criterion.status = 'ENABLED'
  `)

  const records = rows.map((row) => ({
    dealership_id: dealership.id,
    campaign: row.campaign.name ?? null,
    ad_group: row.ad_group.name ?? null,
    keyword: row.ad_group_criterion.keyword?.text ?? null,
    spend: row.metrics.cost_micros != null ? row.metrics.cost_micros / 1_000_000 : null,
    impressions: row.metrics.impressions ?? null,
    clicks: row.metrics.clicks ?? null,
    cpc: row.metrics.average_cpc != null ? row.metrics.average_cpc / 1_000_000 : null,
    conversions: row.metrics.conversions ?? null,
    conversion_value: row.metrics.conversions_value ?? null,
    quality_score: row.ad_group_criterion.quality_info?.quality_score ?? null,
    captured_at: new Date().toISOString(),
    source: 'google-ads',
  }))

  if (records.length === 0) {
    console.log(`[${dealership.id}] No paid search rows for ${date}`)
    return
  }

  const { error } = await supabase.from('rankings_paid').insert(records)
  if (error) throw new Error(`Supabase insert failed for ${dealership.id}: ${error.message}`)
  console.log(`[${dealership.id}] Inserted ${records.length} paid search rows for ${date}`)
}

async function runPaidSearchPull() {
  const adsClient = makeAdsClient()
  const supabase = makeSupabase()
  for (const dealership of DEALERSHIPS) {
    await pullDealership(adsClient, supabase, dealership)
  }
}

async function runWeeklyRollup() {
  const supabase = makeSupabase()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - 7)
  const since = startDate.toISOString()

  for (const dealership of DEALERSHIPS) {
    const { data, error } = await supabase
      .from('rankings_paid')
      .select('campaign, spend, impressions, clicks, conversions, conversion_value')
      .eq('dealership_id', dealership.id)
      .gte('captured_at', since)

    if (error) throw new Error(`Weekly rollup query failed for ${dealership.id}: ${error.message}`)

    const byCampaign = {}
    for (const row of data ?? []) {
      const c = row.campaign ?? 'unknown'
      if (!byCampaign[c]) byCampaign[c] = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value: 0 }
      byCampaign[c].spend += row.spend ?? 0
      byCampaign[c].impressions += row.impressions ?? 0
      byCampaign[c].clicks += row.clicks ?? 0
      byCampaign[c].conversions += row.conversions ?? 0
      byCampaign[c].conversion_value += row.conversion_value ?? 0
    }

    console.log(`[${dealership.id}] Weekly rollup: ${Object.keys(byCampaign).length} campaigns`)
    for (const [campaign, totals] of Object.entries(bycampaign ?? byCampaign)) {
      console.log(`  ${campaign}: $${totals.spend.toFixed(2)} spend, ${totals.clicks} clicks, ${totals.conversions} conversions`)
    }
  }
}

async function main() {
  console.log('Paid search agent starting…')
  await runPaidSearchPull()
  await runWeeklyRollup()
  console.log('Paid search agent done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
