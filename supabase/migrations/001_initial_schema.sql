-- keywords
create table if not exists keywords (
  id uuid default gen_random_uuid() primary key,
  dealership_id text not null,
  keyword text not null,
  intent text check (intent in ('brand','model_location','service','competitor','category')),
  active boolean default true,
  created_at timestamptz default now()
);

-- rankings_organic
create table if not exists rankings_organic (
  id uuid default gen_random_uuid() primary key,
  dealership_id text not null,
  keyword_id uuid references keywords(id),
  keyword text not null,
  position numeric,
  url text,
  clicks integer,
  impressions integer,
  ctr numeric,
  captured_at timestamptz default now(),
  source text not null
);

-- rankings_paid
create table if not exists rankings_paid (
  id uuid default gen_random_uuid() primary key,
  dealership_id text not null,
  campaign text,
  ad_group text,
  keyword text,
  spend numeric,
  impressions integer,
  clicks integer,
  cpc numeric,
  conversions numeric,
  conversion_value numeric,
  quality_score integer,
  captured_at timestamptz default now(),
  source text not null
);

-- ga4_daily
create table if not exists ga4_daily (
  id uuid default gen_random_uuid() primary key,
  dealership_id text not null,
  date date not null,
  sessions integer,
  users integer,
  source_medium text,
  landing_page text,
  device_category text,
  conversions integer,
  conversion_event text,
  captured_at timestamptz default now(),
  source text default 'ga4'
);

-- ai_responses
create table if not exists ai_responses (
  id uuid default gen_random_uuid() primary key,
  dealership_id text not null,
  model text not null,
  prompt text not null,
  intent text,
  response_text text,
  our_name_appeared boolean,
  our_position integer,
  sentiment text check (sentiment in ('positive','neutral','negative','not_mentioned')),
  captured_at timestamptz default now(),
  source text not null
);

-- ai_citations
create table if not exists ai_citations (
  id uuid default gen_random_uuid() primary key,
  response_id uuid references ai_responses(id),
  dealership_id text not null,
  url text,
  domain text,
  is_ours boolean,
  competitor_name text,
  captured_at timestamptz default now(),
  source text not null
);

-- social_posts
create table if not exists social_posts (
  id uuid default gen_random_uuid() primary key,
  dealership_id text not null,
  platform text check (platform in ('facebook','instagram','tiktok')),
  page_name text,
  post_id text,
  post_type text,
  reach integer,
  impressions integer,
  engagement integer,
  likes integer,
  comments integer,
  shares integer,
  captured_at timestamptz default now(),
  source text not null
);

-- social_metrics_daily
create table if not exists social_metrics_daily (
  id uuid default gen_random_uuid() primary key,
  dealership_id text not null,
  platform text check (platform in ('facebook','instagram','tiktok')),
  page_name text,
  date date not null,
  follower_count integer,
  follower_change integer,
  total_reach integer,
  total_impressions integer,
  total_engagement integer,
  paid_roas numeric,
  captured_at timestamptz default now(),
  source text not null
);

-- site_audits
create table if not exists site_audits (
  id uuid default gen_random_uuid() primary key,
  dealership_id text not null,
  url text not null,
  performance_score numeric,
  accessibility_score numeric,
  best_practices_score numeric,
  seo_score numeric,
  lcp numeric,
  fid numeric,
  cls numeric,
  raw_json jsonb,
  captured_at timestamptz default now(),
  source text default 'lighthouse'
);

-- synthesis_runs
create table if not exists synthesis_runs (
  id uuid default gen_random_uuid() primary key,
  dealership_id text,
  week_start date not null,
  wins jsonb,
  issues jsonb,
  anomalies jsonb,
  recommended_actions jsonb,
  raw_summary text,
  captured_at timestamptz default now(),
  source text default 'synthesis-agent'
);
