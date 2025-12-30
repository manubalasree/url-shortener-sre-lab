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

// Test configuration: Scenario 1 - Baseline Normal Day
export const options = {
  scenarios: {
    url_creation: {
      executor: 'constant-arrival-rate',
      exec: 'createURL',
      rate: 1, // 1 URL creation per second
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 2,
      maxVUs: 10,
      startTime: '2m', // Start after ramp-up
    },
    url_redirects: {
      executor: 'constant-arrival-rate',
      exec: 'redirectURL',
      rate: 20, // 20 redirects per second
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 10,
      maxVUs: 50,
      startTime: '2m', // Start after ramp-up
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<500'], // 95% < 200ms, 99% < 500ms
    http_req_failed: ['rate<0.01'], // Error rate < 1%
    'http_req_duration{type:creation}': ['p(95)<500'], // URL creation < 500ms
    'http_req_duration{type:redirect}': ['p(95)<100'], // Redirects < 100ms
  },
};

// Store created short codes for redirect testing
const shortCodes = [];
let shortCodeIndex = 0;

// Setup: Create initial URLs for redirect testing
export function setup() {
  console.log('🚀 Setting up baseline test - creating initial URLs...');
  const initialURLs = [];

  for (let i = 0; i < 100; i++) {
    const payload = JSON.stringify({
      longUrl: `https://example.com/baseline/test-${Date.now()}-${i}`,
      customSlug: `baseline-${Date.now()}-${i}`,
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

    sleep(0.1); // Small delay during setup
  }

  console.log(`✅ Setup complete: created ${initialURLs.length} initial URLs`);
  return { shortCodes: initialURLs };
}

// URL Creation workload
export function createURL(data) {
  const timestamp = Date.now();
  const randomId = Math.floor(Math.random() * 1000000);

  const payload = JSON.stringify({
    longUrl: `https://example.com/test/${timestamp}/${randomId}`,
    findIfExists: false,
    tags: ['load-test', 'scenario1', 'baseline'],
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

// URL Redirect workload
export function redirectURL(data) {
  // Use pre-created URLs from setup or created during test
  let shortCode;

  if (data && data.shortCodes && data.shortCodes.length > 0) {
    shortCode = data.shortCodes[Math.floor(Math.random() * data.shortCodes.length)];
  } else {
    // Fallback if no URLs available
    console.warn('⚠️ No short codes available for redirect test');
    return;
  }

  const params = {
    redirects: 0, // Don't follow redirects
    tags: { type: 'redirect' },
  };

  const res = http.get(`${BASE_URL}/${shortCode}`, params);

  const success = check(res, {
    'Redirect status is 301/302': (r) => r.status === 301 || r.status === 302,
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

  sleep(0.05);
}

// Teardown
export function teardown(data) {
  console.log('🏁 Baseline test completed');
  console.log(`📊 Total URLs created during setup: ${data.shortCodes ? data.shortCodes.length : 0}`);
}

export default function() {
  // This is intentionally empty - we use scenarios above
}
