# Redis Cache Performance Test

This test validates that Redis caching is working effectively and measures the performance improvement.

## What This Test Does

1. **Creates test URLs**: Sets up popular URLs (80% of traffic) and normal URLs (20% of traffic)
2. **Generates realistic traffic**: Follows Pareto distribution (80/20 rule)
3. **Measures cache performance**:
   - Cache hit rate
   - Cache miss rate
   - Response time for cached vs uncached requests
   - Overall latency (P95, P99)
4. **Validates thresholds**:
   - Cache hit rate > 80%
   - Cached responses < 50ms (P95)
   - Uncached responses < 150ms (P95)
   - Success rate > 99%

## Prerequisites

1. **k6 installed**:
   ```bash
   brew install k6
   ```

2. **Shlink running** with Redis enabled (already configured)

3. **Kubernetes access** to retrieve API key

## Quick Start

### Option 1: Automated Script (Recommended)

```bash
cd load-tests
./run-redis-test.sh
```

The script will:
- Check if k6 is installed
- Retrieve Shlink API key from Kubernetes
- Verify Shlink health
- Check Redis status
- Optionally clear cache
- Run the test
- Display results

### Option 2: Manual Execution

```bash
# Get API key
export SHLINK_API_KEY=$(kubectl get secret -n shlink shlink-api-key -o jsonpath='{.data.api-key}' | base64 -d)

# Run test
cd load-tests
k6 run --env SHLINK_API_KEY=$SHLINK_API_KEY redis-cache-performance.js
```

## Test Configuration

### Load Profile

- **Warm-up**: 30s → 20 users
- **Ramp-up**: 1m → 50 users
- **Sustained load**: 2m → 100 users
- **Ramp-down**: 1m → 50 users
- **Cool-down**: 30s → 0 users

Total duration: ~5 minutes

### Traffic Distribution

**Popular URLs** (20% of URLs, 80% of traffic):
- `popular1`, `popular2`, `popular3`, `popular4`

**Normal URLs** (80% of URLs, 20% of traffic):
- `test1` through `test10`

This simulates real-world traffic where a small number of URLs get most of the traffic.

## Expected Results

### With Redis Working

```
Cache Hit Rate:     85-95%
Cache Miss Rate:    5-15%
Avg Cached Time:    5-30ms
Avg Uncached Time:  50-150ms
Performance Gain:   70-90% faster
P95 Latency:        <100ms
P99 Latency:        <200ms
Success Rate:       >99%
```

### Interpreting Results

**Cache Hit Rate**:
- **>80%** ✅ Excellent - Redis is working well
- **60-80%** ⚠️ Fair - Check cache configuration
- **<60%** ❌ Poor - Redis may not be working properly

**Response Times**:
- **Cached (<50ms)** ✅ Expected with Redis
- **Uncached (50-150ms)** ✅ Expected PostgreSQL query time
- **All requests slow (>100ms)** ❌ Redis may not be working

**Performance Gain**:
- **>70%** ✅ Redis providing significant benefit
- **30-70%** ⚠️ Some benefit but could be better
- **<30%** ❌ Redis not providing expected performance

## Monitoring During Test

### Terminal 1: Watch Redis Stats
```bash
watch -n 1 'kubectl exec -n redis rfr-shlink-redis-0 -- redis-cli INFO stats | grep -E "instantaneous_ops_per_sec|keyspace_hits|keyspace_misses"'
```

### Terminal 2: Monitor Cache Keys
```bash
watch -n 2 'kubectl exec -n redis rfr-shlink-redis-0 -- redis-cli DBSIZE'
```

### Terminal 3: Check Pod Resources
```bash
kubectl top pods -n shlink
kubectl top pods -n redis
```

### Observability Dashboards

- **Grafana**: http://192.168.2.242:3000
  - View: CPU, memory, request latency

- **Kiali**: http://192.168.2.242:20001
  - View: Service mesh traffic flow

- **Jaeger**: http://192.168.2.242:16686
  - View: Distributed traces, slow queries

## Output Files

After the test completes:

1. **Console Summary**: Real-time results in terminal
2. **JSON Report**: `results/redis-cache-performance-summary.json`
3. **HTML Report**: `results/redis-cache-performance-report.html`

Open the HTML report:
```bash
open results/redis-cache-performance-report.html
```

## Troubleshooting

### API Key Issues

If you see authentication errors:

```bash
# Manually retrieve API key
kubectl get secret -n shlink shlink-api-key -o jsonpath='{.data.api-key}' | base64 -d

# Or create a new one via Shlink UI/API
```

### URLs Already Exist

The test handles existing URLs gracefully. If URLs already exist from previous runs, they'll be reused.

To start fresh:
```bash
# Clear all short URLs (CAUTION: destructive)
kubectl exec -n shlink deployment/shlink -- bin/cli short-url:delete-all
```

### Low Cache Hit Rate

If cache hit rate is lower than expected:

1. **Check Redis is connected**:
   ```bash
   kubectl exec -n shlink deployment/shlink -c shlink -- php -m | grep redis
   kubectl exec -n redis rfr-shlink-redis-0 -- redis-cli KEYS "shlink:*"
   ```

2. **Verify cache keys exist**:
   ```bash
   kubectl exec -n redis rfr-shlink-redis-0 -- redis-cli DBSIZE
   ```

3. **Check Shlink logs**:
   ```bash
   kubectl logs -n shlink deployment/shlink -c shlink --tail=100
   ```

### Shlink Not Accessible

```bash
# Check pods
kubectl get pods -n shlink

# Check service
kubectl get svc -n shlink

# Check Istio gateway
kubectl get gateway -n shlink
kubectl get virtualservice -n shlink

# Test health endpoint
curl http://192.168.2.242/rest/health
```

## Advanced Usage

### Clear Cache Before Test

```bash
kubectl exec -n redis rfr-shlink-redis-0 -- redis-cli FLUSHALL
```

### Custom Load Profile

Edit `redis-cache-performance.js` and modify the `stages` in `options`:

```javascript
export const options = {
  stages: [
    { duration: '1m', target: 200 },  // Higher load
    { duration: '5m', target: 200 },  // Longer duration
  ],
};
```

### Different Base URL

```bash
k6 run --env BASE_URL=http://your-url --env SHLINK_API_KEY=your-key redis-cache-performance.js
```

## What Success Looks Like

When the test completes successfully, you should see:

```
✅ PASS: Redis caching is working effectively!

📊 Cache Performance:
   Cache Hit Rate:     87.34%
   Cache Miss Rate:    12.66%
   Avg Cached Time:    23.45ms
   Avg Uncached Time:  98.23ms
   Performance Gain:   76.1% faster

⚡ Response Times:
   P95: 67.89ms
   P99: 145.32ms

✅ Success Rate: 99.87%
```

This confirms:
1. ✅ Redis phpredis extension is working
2. ✅ Cache is being populated and used
3. ✅ Performance is significantly better with caching
4. ✅ Application is stable under load

## Next Steps

After validating Redis performance:

1. Run full baseline load test (Scenario 1)
2. Test peak hours scenario (Scenario 2)
3. Test viral event scenario (Scenario 3)
4. Document performance characteristics
5. Consider Redis HA improvements (dynamic master tracking)

## Related Documentation

- [Load Tests README](README.md) - Full load testing suite
- [Session Summary](../docs/SESSION-SUMMARY.md) - Project status
- [Shlink Integration Guide](../docs/03-shlink-integration-guide.md) - Redis setup details
