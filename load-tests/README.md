# Load Testing with k6

This directory contains k6 load test scripts for the Shlink URL shortener system.

## Test Scenarios

Based on realistic traffic patterns for 1000 DAU (Daily Active Users):

### Scenario 1: Baseline - Normal Day
**Goal**: Validate system handles typical daily traffic

**Traffic Pattern**:
- 1 URL creation/sec sustained
- 20 redirects/sec sustained
- 10-minute duration
- 100:1 read:write ratio

**Expected Thresholds**:
- p95 latency < 200ms
- p99 latency < 500ms
- Error rate < 1%

**Use Case**: Establishes performance baseline and validates system health under normal load.

### Scenario 2: Peak Hours
**Goal**: Test under realistic peak load (lunch hour or morning peak)

**Traffic Pattern**:
- 2 URL creations/sec
- 50 redirects/sec
- 5-minute duration
- Simulates concentrated usage periods

**Expected Thresholds**:
- p95 latency < 300ms
- p99 latency < 1000ms
- Error rate < 2%

**Use Case**: Validates autoscaling, resource allocation, and performance during business hours.

### Scenario 3: Viral Event
**Goal**: Test system limits and breaking points

**Traffic Pattern**:
- 5-8 URL creations/sec
- 100-200 redirects/sec with spikes to 150+
- 10-minute duration
- Concentrated traffic to few "viral" URLs (Pareto distribution)

**Expected Thresholds**:
- p95 latency < 500ms
- p99 latency < 2000ms
- Error rate < 5%

**Use Case**: Stress tests caching, identifies bottlenecks, validates circuit breakers and rate limiting.

## Prerequisites

### 1. Install k6

**macOS**:
```bash
brew install k6
```

**Linux**:
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

**Docker**:
```bash
docker pull grafana/k6:latest
```

### 2. Get Shlink API Key

```bash
# Get the API key from AWS Secrets Manager or Kubernetes secret
kubectl get secret -n shlink shlink-api-key -o jsonpath='{.data.api-key}' | base64 -d

# Or create a new API key via Shlink CLI
kubectl exec -n shlink deployment/shlink -- \
  ./vendor/bin/shlink api-key:generate
```

### 3. Set Environment Variables

```bash
export BASE_URL="http://192.168.2.242"
export SHLINK_API_KEY="your-api-key-here"
```

## Running Tests

### Scenario 1: Baseline
```bash
k6 run \
  --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --out json=results/scenario1-baseline.json \
  scenario1-baseline.js
```

### Scenario 2: Peak Hours
```bash
k6 run \
  --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --out json=results/scenario2-peak.json \
  scenario2-peak-hours.js
```

### Scenario 3: Viral Event
```bash
k6 run \
  --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --out json=results/scenario3-viral.json \
  scenario3-viral-event.js
```

### With Real-Time Monitoring (Cloud Output)

If you have k6 Cloud account:
```bash
k6 run \
  --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --out cloud \
  scenario1-baseline.js
```

### With InfluxDB Output (for Grafana)

```bash
k6 run \
  --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --out influxdb=http://localhost:8086/k6 \
  scenario1-baseline.js
```

## Using Docker

```bash
# Scenario 1
docker run --rm -i \
  -e BASE_URL=$BASE_URL \
  -e SHLINK_API_KEY=$SHLINK_API_KEY \
  -v $(pwd):/scripts \
  grafana/k6:latest run /scripts/scenario1-baseline.js

# Scenario 2
docker run --rm -i \
  -e BASE_URL=$BASE_URL \
  -e SHLINK_API_KEY=$SHLINK_API_KEY \
  -v $(pwd):/scripts \
  grafana/k6:latest run /scripts/scenario2-peak-hours.js

# Scenario 3
docker run --rm -i \
  -e BASE_URL=$BASE_URL \
  -e SHLINK_API_KEY=$SHLINK_API_KEY \
  -v $(pwd):/scripts \
  grafana/k6:latest run /scripts/scenario3-viral-event.js
```

## Analyzing Results

### Terminal Output
k6 provides real-time metrics in the terminal:
- Request rate
- Response times (avg, min, max, p90, p95, p99)
- Error rate
- Data transfer
- Virtual users

### JSON Output Analysis
```bash
# Pretty print summary
jq '.metrics' results/scenario1-baseline.json

# Extract specific metrics
jq '.metrics.http_req_duration' results/scenario1-baseline.json

# Check thresholds
jq '.root_group.checks' results/scenario1-baseline.json
```

### Grafana Dashboard
1. Import results to InfluxDB
2. Create Grafana dashboard with:
   - Request rate over time
   - Response time percentiles
   - Error rate
   - Virtual users
   - Custom metrics (url_creation_duration, redirect_duration)

### What to Monitor During Tests

**In Grafana (Existing Dashboards)**:
- CPU and memory usage across Shlink pods
- PostgreSQL connection pool and query performance
- Redis cache hit rate (if enabled)
- Istio ingress gateway metrics
- Network throughput

**In Kiali**:
- Service graph showing request flow
- Error rates by service
- Response time distribution
- Traffic animation

**In Jaeger**:
- Trace samples during load
- Identify slow database queries
- Find bottlenecks in request chain

**In Prometheus**:
```promql
# Request rate
rate(istio_requests_total{destination_service_name="shlink"}[1m])

# Error rate
rate(istio_requests_total{destination_service_name="shlink",response_code=~"5.."}[1m])

# Request duration p95
histogram_quantile(0.95, rate(istio_request_duration_milliseconds_bucket{destination_service_name="shlink"}[1m]))
```

## Performance Targets

### Baseline Targets
| Metric | Target | Acceptable |
|--------|--------|------------|
| Request Rate | 21 req/s | > 15 req/s |
| p95 Latency | < 100ms | < 200ms |
| p99 Latency | < 200ms | < 500ms |
| Error Rate | < 0.1% | < 1% |
| Throughput | Stable | No degradation |

### Peak Hours Targets
| Metric | Target | Acceptable |
|--------|--------|------------|
| Request Rate | 52 req/s | > 40 req/s |
| p95 Latency | < 150ms | < 300ms |
| p99 Latency | < 400ms | < 1000ms |
| Error Rate | < 0.5% | < 2% |
| Pod Autoscaling | Triggered | Within 2 min |

### Viral Event Targets
| Metric | Target | Acceptable |
|--------|--------|------------|
| Request Rate | > 100 req/s | > 75 req/s |
| p95 Latency | < 300ms | < 500ms |
| p99 Latency | < 1000ms | < 2000ms |
| Error Rate | < 2% | < 5% |
| System Stability | No crashes | Graceful degradation |

## Troubleshooting

### High Error Rates
```bash
# Check pod status
kubectl get pods -n shlink

# Check pod logs
kubectl logs -n shlink deployment/shlink --tail=100

# Check database connections
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -c "SELECT count(*) FROM pg_stat_activity;"
```

### High Latency
```bash
# Check resource usage
kubectl top pods -n shlink

# Check if pods are throttled
kubectl describe pod -n shlink <pod-name> | grep -A 5 "State"

# Check database performance
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -c "SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"
```

### Connection Timeouts
```bash
# Check Istio gateway
kubectl get pods -n istio-system

# Check gateway logs
kubectl logs -n istio-system deployment/istio-ingressgateway

# Test direct pod access (bypass Istio)
kubectl port-forward -n shlink deployment/shlink 8080:8080
curl http://localhost:8080/rest/health
```

## Best Practices

1. **Start Small**: Run Scenario 1 first to establish baseline
2. **Monitor Continuously**: Keep Grafana/Kiali open during tests
3. **Allow Cool-Down**: Wait 5-10 minutes between test runs
4. **Save Results**: Always use `--out json` to save results
5. **Document Findings**: Note any anomalies or bottlenecks
6. **Iterate**: Adjust thresholds based on actual system capabilities

## Next Steps After Testing

1. **Analyze Results**: Compare actual vs expected performance
2. **Identify Bottlenecks**: Use Jaeger traces to find slow operations
3. **Optimize**: Database queries, caching, resource limits
4. **Retest**: Validate improvements
5. **Document**: Update architecture docs with performance characteristics
6. **Set Alerts**: Configure Prometheus alerts based on learned thresholds

## References

- [k6 Documentation](https://k6.io/docs/)
- [k6 Test Types](https://k6.io/docs/test-types/introduction/)
- [k6 Metrics](https://k6.io/docs/using-k6/metrics/)
- [Shlink API Documentation](https://shlink.io/documentation/api-docs/)
