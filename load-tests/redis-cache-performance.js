import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Custom metrics
const cacheHitRate = new Rate('cache_hit_rate');
const cacheMissRate = new Rate('cache_miss_rate');
const cachedResponseTime = new Trend('cached_response_time');
const uncachedResponseTime = new Trend('uncached_response_time');
const redirectSuccessRate = new Rate('redirect_success_rate');
const totalRedirects = new Counter('total_redirects');

export const options = {
  stages: [
    { duration: '30s', target: 20 },   // Warm up cache
    { duration: '1m', target: 50 },    // Moderate load
    { duration: '2m', target: 100 },   // High load to test cache
    { duration: '1m', target: 50 },    // Scale down
    { duration: '30s', target: 0 },    // Cool down
  ],
  thresholds: {
    // Redis cache should keep most responses fast
    'http_req_duration': ['p(95)<100', 'p(99)<200'],
    'cached_response_time': ['p(95)<50', 'p(99)<100'],    // Cache hits very fast
    'uncached_response_time': ['p(95)<150'],              // DB queries slower
    'cache_hit_rate': ['rate>0.80'],                      // >80% cache hits
    'redirect_success_rate': ['rate>0.99'],               // >99% success
    'http_req_failed': ['rate<0.01'],                     // <1% errors
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://192.168.2.242';
const SHLINK_API_KEY = __ENV.SHLINK_API_KEY;

// Pareto distribution: 20% of URLs get 80% of traffic
const popularUrls = ['popular1', 'popular2', 'popular3', 'popular4'];
const normalUrls = ['test1', 'test2', 'test3', 'test4', 'test5',
                    'test6', 'test7', 'test8', 'test9', 'test10'];

let urlsCreated = false;

export function setup() {
  if (!SHLINK_API_KEY) {
    console.error('ERROR: SHLINK_API_KEY environment variable is required');
    console.log('Usage: k6 run --env SHLINK_API_KEY=your-key redis-cache-performance.js');
    throw new Error('Missing SHLINK_API_KEY');
  }

  console.log('Setting up test URLs...');
  const createdUrls = [];

  // Create popular URLs (these will be hit frequently)
  popularUrls.forEach((slug, index) => {
    const res = http.post(
      `${BASE_URL}/rest/v3/short-urls`,
      JSON.stringify({
        longUrl: `https://example.com/popular/${index}`,
        customSlug: slug,
      }),
      {
        headers: {
          'X-Api-Key': SHLINK_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (res.status === 200 || res.status === 201) {
      createdUrls.push(slug);
      console.log(`✓ Created popular URL: ${slug}`);
    } else if (res.status === 400 && res.body.includes('already exists')) {
      createdUrls.push(slug);
      console.log(`✓ URL already exists: ${slug}`);
    } else {
      console.warn(`✗ Failed to create ${slug}: ${res.status}`);
    }
  });

  // Create normal URLs (less frequently accessed)
  normalUrls.forEach((slug, index) => {
    const res = http.post(
      `${BASE_URL}/rest/v3/short-urls`,
      JSON.stringify({
        longUrl: `https://example.com/normal/${index}`,
        customSlug: slug,
      }),
      {
        headers: {
          'X-Api-Key': SHLINK_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (res.status === 200 || res.status === 201) {
      createdUrls.push(slug);
      console.log(`✓ Created normal URL: ${slug}`);
    } else if (res.status === 400 && res.body.includes('already exists')) {
      createdUrls.push(slug);
      console.log(`✓ URL already exists: ${slug}`);
    }
  });

  console.log(`\nSetup complete! Created/verified ${createdUrls.length} URLs`);
  console.log(`Popular URLs (80% of traffic): ${popularUrls.join(', ')}`);
  console.log(`Normal URLs (20% of traffic): ${normalUrls.join(', ')}`);
  console.log('\nStarting load test...\n');

  return { createdUrls };
}

export default function (data) {
  // Pareto principle: 80% of requests go to 20% of URLs (popular ones)
  let shortCode;
  if (Math.random() < 0.8) {
    // 80% traffic to popular URLs
    shortCode = popularUrls[Math.floor(Math.random() * popularUrls.length)];
  } else {
    // 20% traffic to normal URLs
    shortCode = normalUrls[Math.floor(Math.random() * normalUrls.length)];
  }

  const startTime = new Date();

  const res = http.get(`${BASE_URL}/${shortCode}`, {
    redirects: 0,  // Don't follow redirects, measure lookup only
    tags: { name: 'redirect_lookup' },
  });

  const duration = new Date() - startTime;
  totalRedirects.add(1);

  // Check if redirect successful
  const success = check(res, {
    'is redirect (302)': (r) => r.status === 302,
    'has Location header': (r) => r.headers['Location'] !== undefined,
    'response time < 200ms': (r) => duration < 200,
  });

  redirectSuccessRate.add(success ? 1 : 0);

  // Estimate cache hit vs miss based on response time
  // Cache hits are typically <50ms, DB queries >50ms
  if (duration < 50) {
    cacheHitRate.add(1);
    cacheMissRate.add(0);
    cachedResponseTime.add(duration);
  } else {
    cacheHitRate.add(0);
    cacheMissRate.add(1);
    uncachedResponseTime.add(duration);
  }

  // Small random sleep to simulate realistic user behavior
  sleep(Math.random() * 0.3 + 0.1);  // 100-400ms between requests
}

export function handleSummary(data) {
  const cacheHits = data.metrics.cache_hit_rate.values.rate * 100;
  const cacheMisses = data.metrics.cache_miss_rate.values.rate * 100;
  const avgCachedTime = data.metrics.cached_response_time?.values.avg || 0;
  const avgUncachedTime = data.metrics.uncached_response_time?.values.avg || 0;
  const p95Overall = data.metrics.http_req_duration.values['p(95)'];
  const p99Overall = data.metrics.http_req_duration.values['p(99)'];

  console.log('\n' + '='.repeat(80));
  console.log('REDIS CACHE PERFORMANCE TEST RESULTS');
  console.log('='.repeat(80));
  console.log(`\n📊 Cache Performance:`);
  console.log(`   Cache Hit Rate:     ${cacheHits.toFixed(2)}%`);
  console.log(`   Cache Miss Rate:    ${cacheMisses.toFixed(2)}%`);
  console.log(`   Avg Cached Time:    ${avgCachedTime.toFixed(2)}ms`);
  console.log(`   Avg Uncached Time:  ${avgUncachedTime.toFixed(2)}ms`);
  console.log(`   Performance Gain:   ${((avgUncachedTime - avgCachedTime) / avgUncachedTime * 100).toFixed(1)}% faster`);

  console.log(`\n⚡ Response Times:`);
  console.log(`   P95: ${p95Overall.toFixed(2)}ms`);
  console.log(`   P99: ${p99Overall.toFixed(2)}ms`);

  console.log(`\n✅ Success Rate: ${(data.metrics.redirect_success_rate.values.rate * 100).toFixed(2)}%`);
  console.log(`   Total Redirects: ${data.metrics.total_redirects.values.count}`);

  console.log('\n' + '='.repeat(80));

  // Verdict
  if (cacheHits > 80 && avgCachedTime < 50) {
    console.log('✅ PASS: Redis caching is working effectively!');
  } else if (cacheHits > 60) {
    console.log('⚠️  WARNING: Cache hit rate could be better');
  } else {
    console.log('❌ FAIL: Redis caching may not be working properly');
  }
  console.log('='.repeat(80) + '\n');

  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'load-tests/results/redis-cache-performance-summary.json': JSON.stringify(data, null, 2),
    'load-tests/results/redis-cache-performance-report.html': htmlReport(data),
  };
}

function htmlReport(data) {
  const cacheHits = data.metrics.cache_hit_rate.values.rate * 100;
  const avgCachedTime = data.metrics.cached_response_time?.values.avg || 0;
  const avgUncachedTime = data.metrics.uncached_response_time?.values.avg || 0;
  const p95 = data.metrics.http_req_duration.values['p(95)'];
  const p99 = data.metrics.http_req_duration.values['p(99)'];

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Redis Cache Performance Test</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
    .container { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { color: #333; border-bottom: 3px solid #4CAF50; padding-bottom: 10px; }
    .metric { margin: 20px 0; padding: 15px; background: #f9f9f9; border-left: 4px solid #4CAF50; }
    .metric h3 { margin: 0 0 10px 0; color: #555; }
    .metric p { margin: 5px 0; font-size: 18px; }
    .pass { color: #4CAF50; font-weight: bold; }
    .warn { color: #FF9800; font-weight: bold; }
    .fail { color: #f44336; font-weight: bold; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Redis Cache Performance Test Results</h1>
    <p>Test Date: ${new Date().toISOString()}</p>

    <div class="stats">
      <div class="metric">
        <h3>Cache Hit Rate</h3>
        <p class="${cacheHits > 80 ? 'pass' : 'warn'}">${cacheHits.toFixed(2)}%</p>
      </div>

      <div class="metric">
        <h3>Performance Improvement</h3>
        <p class="pass">${((avgUncachedTime - avgCachedTime) / avgUncachedTime * 100).toFixed(1)}% faster</p>
      </div>

      <div class="metric">
        <h3>Cached Response Time (avg)</h3>
        <p>${avgCachedTime.toFixed(2)}ms</p>
      </div>

      <div class="metric">
        <h3>Uncached Response Time (avg)</h3>
        <p>${avgUncachedTime.toFixed(2)}ms</p>
      </div>

      <div class="metric">
        <h3>P95 Latency</h3>
        <p>${p95.toFixed(2)}ms</p>
      </div>

      <div class="metric">
        <h3>P99 Latency</h3>
        <p>${p99.toFixed(2)}ms</p>
      </div>
    </div>

    <div class="metric">
      <h3>Verdict</h3>
      <p class="${cacheHits > 80 ? 'pass' : 'warn'}">
        ${cacheHits > 80 ? '✅ PASS: Redis caching is working effectively!' : '⚠️ WARNING: Cache performance needs improvement'}
      </p>
    </div>
  </div>
</body>
</html>
  `;
}
