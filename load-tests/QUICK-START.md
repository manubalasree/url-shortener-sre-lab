# Quick Start Guide - Load Testing

## TL;DR - Run Tests Now

```bash
# 1. Install k6 (if not already installed)
brew install k6  # macOS
# OR for Linux, see: https://k6.io/docs/getting-started/installation/

# 2. Set environment variables
export BASE_URL="http://192.168.2.242"
export SHLINK_API_KEY="your-api-key-here"

# 3. Run a test
cd load-tests
k6 run --env BASE_URL=$BASE_URL --env SHLINK_API_KEY=$SHLINK_API_KEY scenario1-baseline.js
```

## Get Shlink API Key

### Option 1: From Kubernetes (if deployed via ArgoCD)
```bash
kubectl get secret -n shlink shlink-api-key -o jsonpath='{.data.api-key}' | base64 -d
```

### Option 2: Generate New API Key
```bash
kubectl exec -n shlink deployment/shlink -- \
  ./vendor/bin/shlink api-key:generate
```

### Option 3: Use Shlink Web UI
1. Open http://192.168.2.242
2. Login to Shlink admin panel
3. Navigate to API Keys section
4. Create new API key

## Test Scenarios Overview

| Scenario | Duration | URL Creations/sec | Redirects/sec | Use Case |
|----------|----------|-------------------|---------------|----------|
| **Scenario 1: Baseline** | 10 min | 1 | 20 | Normal day traffic |
| **Scenario 2: Peak Hours** | 5 min | 2 | 50 | Lunch/morning peak |
| **Scenario 3: Viral Event** | 10 min | 5-8 | 100-200+ | Marketing campaign |

## Run Individual Tests

### Scenario 1: Baseline
```bash
k6 run \
  --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --out json=results/baseline.json \
  scenario1-baseline.js
```

### Scenario 2: Peak Hours
```bash
k6 run \
  --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --out json=results/peak.json \
  scenario2-peak-hours.js
```

### Scenario 3: Viral Event
```bash
k6 run \
  --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --out json=results/viral.json \
  scenario3-viral-event.js
```

## Using the Run Script (Recommended)

```bash
# Make script executable
chmod +x run-tests.sh

# Interactive menu
./run-tests.sh

# Or run specific scenario
./run-tests.sh scenario1   # Baseline
./run-tests.sh scenario2   # Peak hours
./run-tests.sh scenario3   # Viral event
./run-tests.sh all         # All scenarios with cool-down periods
```

## What to Monitor During Tests

### Before Running Tests
1. Open Grafana: http://192.168.2.242:3000
   - Navigate to Kubernetes/Istio dashboards
2. Open Kiali: http://192.168.2.242:20001
   - View service graph
3. Open Jaeger: http://192.168.2.242:16686
   - Prepare to view traces

### During Tests - Watch These Metrics

**In k6 Terminal Output**:
- ✅ http_req_duration (response times)
- ✅ http_req_failed (error rate)
- ✅ http_reqs (request rate)
- ✅ iterations (virtual users)

**In Grafana**:
- CPU and memory usage (shlink pods)
- PostgreSQL connections and query time
- Istio request rate and latency
- Pod count (if HPA is enabled)

**In Kiali**:
- Live traffic flow
- Error rates by service
- Response time heatmap

**In Jaeger**:
- Sample traces during load
- Database query times
- Slow requests

## Expected Results

### Scenario 1: Baseline (Success Criteria)
- ✅ Zero errors
- ✅ p95 latency < 200ms
- ✅ p99 latency < 500ms
- ✅ Steady resource usage

### Scenario 2: Peak Hours (Success Criteria)
- ✅ Error rate < 2%
- ✅ p95 latency < 300ms
- ✅ p99 latency < 1000ms
- ✅ Pods scale up (if HPA enabled)

### Scenario 3: Viral Event (Success Criteria)
- ✅ System doesn't crash
- ✅ Error rate < 5%
- ✅ p95 latency < 500ms
- ✅ Graceful degradation (not failure)

## Troubleshooting

### "permission denied" when running tests
```bash
chmod +x run-tests.sh
```

### "k6: command not found"
```bash
# Install k6 first
brew install k6  # macOS

# Or use Docker
docker run --rm -i \
  -e BASE_URL=$BASE_URL \
  -e SHLINK_API_KEY=$SHLINK_API_KEY \
  -v $(pwd):/scripts \
  grafana/k6:latest run /scripts/scenario1-baseline.js
```

### "SHLINK_API_KEY is not set"
```bash
# Get from Kubernetes
export SHLINK_API_KEY=$(kubectl get secret -n shlink shlink-api-key -o jsonpath='{.data.api-key}' | base64 -d)

# Or set manually
export SHLINK_API_KEY="your-key-here"
```

### High error rates during test
```bash
# Check pod status
kubectl get pods -n shlink

# Check pod logs
kubectl logs -n shlink deployment/shlink --tail=100 -f

# Check pod resources
kubectl top pods -n shlink
```

### Connection timeouts
```bash
# Test direct access
curl http://192.168.2.242/rest/health

# Check Istio gateway
kubectl get svc -n istio-system istio-ingressgateway
```

## Post-Test Analysis

### View k6 Summary
The test will display a summary at the end showing:
- Total requests
- Request rate
- Response time percentiles
- Error rate
- Check pass/fail status

### Analyze JSON Results
```bash
# View all metrics
jq '.metrics' results/baseline.json

# View specific metric
jq '.metrics.http_req_duration' results/baseline.json

# View checks
jq '.root_group.checks' results/baseline.json
```

### Check System Metrics in Grafana
1. Go to Grafana: http://192.168.2.242:3000
2. Open "Kubernetes / Compute Resources / Pod" dashboard
3. Select namespace: `shlink`
4. Review CPU, memory, network usage during test period

### Review Traces in Jaeger
1. Go to Jaeger: http://192.168.2.242:16686
2. Select service: `shlink.shlink`
3. Look for:
   - Slowest requests (sort by duration)
   - Failed requests (errors)
   - Database query times

## Next Steps After Testing

1. ✅ Document findings in test results doc
2. ✅ Identify any bottlenecks or issues
3. ✅ Optimize if needed (database, caching, resources)
4. ✅ Re-run tests to validate improvements
5. ✅ Update SESSION-SUMMARY.md with performance results
6. ✅ Set up Prometheus alerts based on thresholds

## Tips for Success

1. **Run Baseline First**: Always start with Scenario 1 to establish normal performance
2. **Allow Cool-Down**: Wait 5-10 minutes between tests
3. **Monitor Continuously**: Keep Grafana/Kiali open
4. **Save Results**: Always use `--out json` flag
5. **Document Everything**: Take screenshots and notes
6. **Start Small**: If system struggles, reduce test duration or intensity
7. **Check Health**: Verify `/rest/health` endpoint before each test

## References

- Full documentation: [README.md](README.md)
- k6 docs: https://k6.io/docs/
- Shlink API docs: https://shlink.io/documentation/api-docs/
