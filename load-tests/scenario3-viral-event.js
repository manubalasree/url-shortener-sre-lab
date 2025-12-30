import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics
const urlCreationErrors = new Counter('url_creation_errors');
const redirectErrors = new Counter('redirect_errors');
const urlCreationDuration = new Trend('url_creation_duration');
const redirectDuration = new Trend('redirect_duration');
const successRate = new Rate('success_rate');
const viralSpikeCounter = new Counter('viral_spike_requests');

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://192.168.2.242';
const API_KEY = __ENV.SHLINK_API_KEY || 'your-api-key-here';

// Test configuration: Scenario 3 - Viral Event
// Simulates viral link or marketing campaign with traffic spikes
export const options = {
  scenarios: {
    url_creation_viral: {
      executor: 'ramping-arrival-rate',
      exec: 'createURL',
      startRate: 2,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 50,
      stages: [
        { duration: '1m', target: 3 }, // Gradual increase
        { duration: '2m', target: 5 }, // Building momentum
        { duration: '4m', target: 5 }, // Sustained viral creation
        { duration: '2m', target: 8 }, // Peak viral activity
        { duration: '1m', target: 2 }, // Cool down
      ],
    },
    url_redirects_viral: {
      executor: 'ramping-arrival-rate',
      exec: 'redirectURL',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 300,
      stages: [
        { duration: '1m', target: 80 }, // Initial viral spread
        { duration: '2m', target: 120 }, // Going viral
        { duration: '2m', target: 180 }, // Peak viral traffic
        { duration: '2m', target: 200 }, // Maximum viral load
        { duration: '2m', target: 120 }, // Start to decline
        { duration: '1m', target: 50 }, // Return to normal
      ],
    },
    // Simulate traffic spikes to specific viral URLs
    viral_spikes: {
      executor: 'ramping-arrival-rate',
      exec: 'viralSpike',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 100,
      stages: [
        { duration: '2m', target: 0 }, // No spikes initially
        { duration: '30s', target: 50 }, // Sudden spike
        { duration: '1m', target: 100 }, // Peak spike
        { duration: '30s', target: 150 }, // Maximum spike
        { duration: '2m', target: 80 }, // Sustained high traffic
        { duration: '1m', target: 30 }, // Declining
        { duration: '2m', target: 0 }, // Spike over
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<2000'], // More lenient for viral load
    http_req_failed: ['rate<0.05'], // Allow up to 5% errors during viral event
    'http_req_duration{type:creation}': ['p(95)<1500', 'p(99)<3000'],
    'http_req_duration{type:redirect}': ['p(95)<300', 'p(99)<1000'],
    'http_req_duration{type:viral}': ['p(95)<400'], // Viral URLs should be cached
    http_reqs: ['rate>50'], // Minimum 50 requests/sec during viral event
  },
};

// Store created short codes
let viralURLs = []; // URLs that will go "viral"

// Setup: Create initial URLs and designate some as viral
export function setup() {
  console.log('🚀 Setting up viral event test - creating initial URLs...');
  const initialURLs = [];
  const viralCandidates = [];

  // Create 300 regular URLs
  for (let i = 0; i < 300; i++) {
    const payload = JSON.stringify({
      longUrl: `https://example.com/viral/content-${Date.now()}-${i}`,
      customSlug: `viral-${Date.now()}-${i}`,
      findIfExists: false,
      tags: ['load-test', 'scenario3', 'viral-event'],
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

      // Mark first 10 URLs as "viral" candidates
      if (i < 10) {
        viralCandidates.push(body.shortCode);
      }
    }

    sleep(0.1);
  }

  console.log(`✅ Setup complete: created ${initialURLs.length} URLs`);
  console.log(`🔥 ${viralCandidates.length} URLs designated as viral candidates`);

  return {
    shortCodes: initialURLs,
    viralURLs: viralCandidates,
  };
}

// URL Creation workload - Viral event
export function createURL(data) {
  const timestamp = Date.now();
  const randomId = Math.floor(Math.random() * 1000000);

  // Simulate campaign/marketing URLs with metadata
  const payload = JSON.stringify({
    longUrl: `https://example.com/campaign/${timestamp}/${randomId}?utm_source=viral&utm_medium=social`,
    findIfExists: false,
    tags: ['viral-campaign', 'marketing', 'scenario3'],
    title: `Viral Content ${randomId}`,
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
    'URL creation response time < 3s': (r) => r.timings.duration < 3000,
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

// URL Redirect workload - Viral event with realistic distribution
export function redirectURL(data) {
  if (!data || !data.shortCodes || data.shortCodes.length === 0) {
    console.warn('⚠️ No short codes available for redirect test');
    return;
  }

  let shortCode;
  const random = Math.random();

  // Realistic viral distribution:
  // 60% traffic to viral URLs (top 3%)
  // 30% traffic to popular URLs (next 17%)
  // 10% traffic to long tail
  if (random < 0.6 && data.viralURLs && data.viralURLs.length > 0) {
    // Access viral URLs (concentrated traffic)
    shortCode = data.viralURLs[Math.floor(Math.random() * data.viralURLs.length)];
  } else if (random < 0.9 && data.shortCodes.length > 10) {
    // Access popular URLs (first 20%)
    const popularRange = Math.floor(data.shortCodes.length * 0.2);
    shortCode = data.shortCodes[Math.floor(Math.random() * popularRange)];
  } else {
    // Access long tail
    shortCode = data.shortCodes[Math.floor(Math.random() * data.shortCodes.length)];
  }

  const params = {
    redirects: 0,
    tags: { type: 'redirect' },
  };

  const res = http.get(`${BASE_URL}/${shortCode}`, params);

  const success = check(res, {
    'Redirect status is 301/302': (r) => r.status === 301 || r.status === 302,
    'Redirect response time < 1s': (r) => r.timings.duration < 1000,
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

  sleep(0.01); // Minimal sleep for viral traffic
}

// Viral spike - concentrated traffic to specific URLs
export function viralSpike(data) {
  if (!data || !data.viralURLs || data.viralURLs.length === 0) {
    console.warn('⚠️ No viral URLs available');
    return;
  }

  // Heavily concentrated traffic to just 1-2 viral URLs
  const viralIndex = Math.floor(Math.random() * Math.min(3, data.viralURLs.length));
  const shortCode = data.viralURLs[viralIndex];

  const params = {
    redirects: 0,
    tags: { type: 'viral' },
  };

  const res = http.get(`${BASE_URL}/${shortCode}`, params);

  viralSpikeCounter.add(1);

  const success = check(res, {
    'Viral redirect status is 301/302': (r) => r.status === 301 || r.status === 302,
    'Viral redirect cached (fast response)': (r) => r.timings.duration < 100,
  });

  if (success) {
    successRate.add(1);
  } else {
    successRate.add(0);
    redirectErrors.add(1);
  }

  // No sleep - simulating rapid concurrent requests
}

// Teardown
export function teardown(data) {
  console.log('🏁 Viral event test completed');
  console.log(`📊 Total URLs: ${data.shortCodes ? data.shortCodes.length : 0}`);
  console.log(`🔥 Viral URLs: ${data.viralURLs ? data.viralURLs.length : 0}`);
}

export default function() {
  // This is intentionally empty - we use scenarios above
}
