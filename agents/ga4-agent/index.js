import { BetaAnalyticsDataClient } from '@google-analytics/data'
import { createClient } from '@supabase/supabase-js'
import { DEALERSHIPS } from '../../lib/config.js'

const PROPERTY_IDS = {
  chevrolet: process.env.GA4_PROPERTY_CHEVROLET,
  cdjr: process.env.GA4_PROPERTY_CDJR,
}

function yesterday() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

function makeSupabase() {
  return createClient(
    process.env.MARKETING_SUPABASE_URL,
    process.env.MARKETING_SUPABASE_SERVICE_KEY
  )
}

function makeAnalyticsClient() {
  const credentials = JSON.parse(process.env.MARKETING_GA4_CREDENTIALS)
  return new BetaAnalyticsDataClient({ credentials })
}

async function pullDealership(analyticsClient, supabase, dealership) {
  const propertyId = PROPERTY_IDS[dealership.id]
  if (!propertyId) throw new Error(`No GA4 property ID for ${dealership.id}`)

  const date = yesterday()

  const [response] = await analyticsClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [
      { name: 'sessionSourceMedium' },
      { name: 'landingPage' },
      { name: 'deviceCategory' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'conversions' },
      { name: 'screenPageViews' },
    ],
  })

  const rows = (response.rows ?? []).map((row) => {
    const dim = (i) => row.dimensionValues[i]?.value ?? null
    const met = (i) => parseInt(row.metricValues[i]?.value ?? '0', 10)
    return {
      dealership_id: dealership.id,
      date,
      source_medium: dim(0),
      landing_page: dim(1),
      device_category: dim(2),
      sessions: met(0),
      users: met(1),
      conversions: met(2),
      source: 'ga4',
    }
  })

  if (rows.length === 0) {
    console.log(`[${dealership.id}] No rows for ${date}`)
    return
  }

  const { error } = await supabase.from('ga4_daily').insert(rows)
  if (error) throw new Error(`Supabase insert failed for ${dealership.id}: ${error.message}`)
  console.log(`[${dealership.id}] Inserted ${rows.length} rows for ${date}`)
}

async function runGA4Pull() {
  const analyticsClient = makeAnalyticsClient()
  const supabase = makeSupabase()

  for (const dealership of DEALERSHIPS) {
    await pullDealership(analyticsClient, supabase, dealership)
  }
}

async function main() {
  console.log('GA4 agent starting…')
  await runGA4Pull()
  console.log('GA4 agent done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
