import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics
const urlCreationErrors = new Counter('url_creation_errors');
const redirectErrors = new Counter('redirect_errors');
const urlCreationDuration = new Trend('url_creation_duration');
const redirectDuration = new Trend('redirect_duration');
const successRate = new Rate('success_rate');

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://192.168.2.242';
const API_KEY = __ENV.SHLINK_API_KEY || 'your-api-key-here';

// Test configuration: Scenario 2 - Peak Hours
// Simulates lunch hour or morning peak with increased traffic
export const options = {
  scenarios: {
    url_creation_peak: {
      executor: 'ramping-arrival-rate',
      exec: 'createURL',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 5,
      maxVUs: 20,
      stages: [
        { duration: '30s', target: 2 }, // Ramp up to 2 URL creations/sec
        { duration: '4m30s', target: 2 }, // Sustain 2 creations/sec for 4.5 minutes
        { duration: '30s', target: 0 }, // Ramp down
      ],
    },
    url_redirects_peak: {
      executor: 'ramping-arrival-rate',
      exec: 'redirectURL',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 100,
      stages: [
        { duration: '30s', target: 50 }, // Ramp up to 50 redirects/sec
        { duration: '4m30s', target: 50 }, // Sustain 50 redirects/sec
        { duration: '30s', target: 20 }, // Ramp down to baseline
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<1000'], // More lenient during peak
    http_req_failed: ['rate<0.02'], // Allow up to 2% errors during peak
    'http_req_duration{type:creation}': ['p(95)<800', 'p(99)<2000'],
    'http_req_duration{type:redirect}': ['p(95)<150', 'p(99)<500'],
    http_reqs: ['rate>30'], // Minimum 30 requests/sec during test
  },
};

// Store created short codes for redirect testing
let shortCodes = [];

// Setup: Create initial URLs for redirect testing
export function setup() {
  console.log('🚀 Setting up peak hours test - creating initial URLs...');
  const initialURLs = [];

  // Create more URLs for peak testing (200 instead of 100)
  for (let i = 0; i < 200; i++) {
    const payload = JSON.stringify({
      longUrl: `https://example.com/peak/test-${Date.now()}-${i}`,
      customSlug: `peak-${Date.now()}-${i}`,
      findIfExists: false,
    });

    const params = {
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
      },
      tags: { type: 'setup' },
    };

    const res = http.post(`${BASE_URL}/rest/v3/short-urls`, payload, params);

    if (res.status === 200 || res.status === 201) {
      const body = JSON.parse(res.body);
      initialURLs.push(body.shortCode);
    }

    sleep(0.1);
  }

  console.log(`✅ Setup complete: created ${initialURLs.length} initial URLs`);
  return { shortCodes: initialURLs };
}

// URL Creation workload - Peak hours
export function createURL(data) {
  const timestamp = Date.now();
  const randomId = Math.floor(Math.random() * 1000000);

  const payload = JSON.stringify({
    longUrl: `https://example.com/peak/${timestamp}/${randomId}`,
    findIfExists: false,
    tags: ['load-test', 'scenario2', 'peak-hours'],
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': API_KEY,
    },
    tags: { type: 'creation' },
  };

  const res = http.post(`${BASE_URL}/rest/v3/short-urls`, payload, params);

  const success = check(res, {
    'URL creation status is 200/201': (r) => r.status === 200 || r.status === 201,
    'URL creation response time < 2s': (r) => r.timings.duration < 2000,
    'URL creation has shortCode': (r) => {
      if (r.status === 200 || r.status === 201) {
        const body = JSON.parse(r.body);
        return body.shortCode !== undefined;
      }
      return false;
    },
  });

  if (success) {
    successRate.add(1);
    urlCreationDuration.add(res.timings.duration);

    // Store shortCode for redirect testing
    if (res.status === 200 || res.status === 201) {
      const body = JSON.parse(res.body);
      if (data && data.shortCodes) {
        data.shortCodes.push(body.shortCode);
      }
    }
  } else {
    successRate.add(0);
    urlCreationErrors.add(1);
    console.error(`❌ URL creation failed: ${res.status} - ${res.body}`);
  }

  sleep(0.1);
}

// URL Redirect workload - Peak hours
export function redirectURL(data) {
  if (!data || !data.shortCodes || data.shortCodes.length === 0) {
    console.warn('⚠️ No short codes available for redirect test');
    return;
  }

  // Simulate realistic access patterns:
  // 80% access popular URLs (first 20%), 20% access long tail
  let shortCode;
  const random = Math.random();

  if (random < 0.8 && data.shortCodes.length > 5) {
    // Access popular URLs (first 20% of created URLs)
    const popularRange = Math.floor(data.shortCodes.length * 0.2);
    shortCode = data.shortCodes[Math.floor(Math.random() * popularRange)];
  } else {
    // Access any URL (long tail)
    shortCode = data.shortCodes[Math.floor(Math.random() * data.shortCodes.length)];
  }

  const params = {
    redirects: 0, // Don't follow redirects
    tags: { type: 'redirect' },
  };

  const res = http.get(`${BASE_URL}/${shortCode}`, params);

  const success = check(res, {
    'Redirect status is 301/302': (r) => r.status === 301 || r.status === 302,
    'Redirect response time < 500ms': (r) => r.timings.duration < 500,
    'Redirect has Location header': (r) => r.headers['Location'] !== undefined,
  });

  if (success) {
    successRate.add(1);
    redirectDuration.add(res.timings.duration);
  } else {
    successRate.add(0);
    redirectErrors.add(1);
    if (res.status !== 301 && res.status !== 302) {
      console.error(`❌ Redirect failed for ${shortCode}: ${res.status}`);
    }
  }

  sleep(0.02); // Less sleep during peak to maintain throughput
}

// Teardown
export function teardown(data) {
  console.log('🏁 Peak hours test completed');
  console.log(`📊 Total URLs available for testing: ${data.shortCodes ? data.shortCodes.length : 0}`);
}

export default function() {
  // This is intentionally empty - we use scenarios above
}
