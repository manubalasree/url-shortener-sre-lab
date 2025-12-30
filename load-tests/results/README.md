# Load Test Results

This directory contains the output from k6 load tests.

## File Naming Convention

Results are automatically saved with timestamps:
- `scenario1-baseline-YYYYMMDD-HHMMSS.json` - Full metrics data
- `scenario1-baseline-YYYYMMDD-HHMMSS-summary.txt` - Human-readable summary
- `scenario2-peak-hours-YYYYMMDD-HHMMSS.json`
- `scenario3-viral-event-YYYYMMDD-HHMMSS.json`

## Analyzing Results

### Quick Summary View
```bash
# View the summary file (created with --summary-export)
cat scenario1-baseline-*-summary.txt
```

### JSON Analysis with jq
```bash
# Get all metric names
jq '.metrics | keys' scenario1-baseline-*.json

# View HTTP request duration percentiles
jq '.metrics.http_req_duration.values' scenario1-baseline-*.json

# View custom metrics
jq '.metrics | {
  url_creation_duration,
  redirect_duration,
  success_rate
}' scenario1-baseline-*.json

# Check threshold pass/fail
jq '.metrics | to_entries[] | select(.value.thresholds) | {
  name: .key,
  thresholds: .value.thresholds
}' scenario1-baseline-*.json
```

### Key Metrics to Review

**Response Times**:
- `http_req_duration` - Overall request duration
- `http_req_waiting` - Time to first byte (TTFB)
- `http_req_connecting` - Connection establishment time

**Request Rates**:
- `http_reqs` - Total requests per second
- `iterations` - Virtual user iterations

**Error Rates**:
- `http_req_failed` - Failed requests rate
- Custom counters: `url_creation_errors`, `redirect_errors`

**Custom Metrics**:
- `url_creation_duration` - Time to create URLs
- `redirect_duration` - Time for redirects
- `success_rate` - Overall success rate

## Comparing Results

### Compare Two Test Runs
```bash
# Extract p95 latency from two runs
echo "Run 1 p95:"
jq '.metrics.http_req_duration.values.p95' scenario1-baseline-20241230-100000.json

echo "Run 2 p95:"
jq '.metrics.http_req_duration.values.p95' scenario1-baseline-20241230-110000.json
```

### Generate Comparison Report
```bash
# Create a simple comparison
for file in scenario1-baseline-*.json; do
  echo "=== $(basename $file) ==="
  jq '{
    test: "Scenario 1",
    duration: .state.testRunDurationMs,
    requests: .metrics.http_reqs.values.count,
    req_rate: .metrics.http_reqs.values.rate,
    p95_duration: .metrics.http_req_duration.values.p95,
    p99_duration: .metrics.http_req_duration.values.p99,
    error_rate: .metrics.http_req_failed.values.rate
  }' "$file"
done
```

## Expected Baseline Values

Based on the test scenarios:

### Scenario 1: Baseline
- Request rate: ~21 req/s (1 creation + 20 redirects)
- p95 latency: < 200ms
- p99 latency: < 500ms
- Error rate: < 1%

### Scenario 2: Peak Hours
- Request rate: ~52 req/s (2 creations + 50 redirects)
- p95 latency: < 300ms
- p99 latency: < 1000ms
- Error rate: < 2%

### Scenario 3: Viral Event
- Request rate: > 100 req/s
- p95 latency: < 500ms
- p99 latency: < 2000ms
- Error rate: < 5%

## Integration with Grafana

To visualize k6 results in Grafana:

### Option 1: Import JSON Manually
1. Upload JSON to k6 Cloud (free tier available)
2. View in k6 Cloud dashboard

### Option 2: InfluxDB + Grafana
```bash
# Run test with InfluxDB output
k6 run \
  --out influxdb=http://localhost:8086/k6 \
  scenario1-baseline.js
```

Then create Grafana dashboard querying InfluxDB.

### Option 3: Prometheus Remote Write
```bash
# Use k6 Prometheus remote write extension
k6 run \
  --out experimental-prometheus-rw \
  scenario1-baseline.js
```

## Cleanup Old Results

```bash
# Keep only last 10 results per scenario
for scenario in scenario1-baseline scenario2-peak-hours scenario3-viral-event; do
  ls -t ${scenario}-*.json 2>/dev/null | tail -n +11 | xargs rm -f
done
```

## Backup Important Results

```bash
# Archive results for a specific date
tar -czf results-backup-$(date +%Y%m%d).tar.gz *.json *.txt

# Copy to docs folder for documentation
cp scenario1-baseline-YYYYMMDD-HHMMSS.json ../docs/test-results/
```

## Common Issues and Solutions

### Large JSON Files
If JSON files are too large (>100MB):
```bash
# Use summary export only
k6 run --summary-export=summary.txt scenario1-baseline.js

# Or limit JSON output to specific metrics
k6 run --out json=results.json scenario1-baseline.js
```

### Out of Disk Space
```bash
# Check disk usage
du -sh results/

# Clean up old results
find results/ -name "*.json" -mtime +7 -delete
```

## References

- [k6 Metrics Documentation](https://k6.io/docs/using-k6/metrics/)
- [k6 Results Output](https://k6.io/docs/getting-started/results-output/)
- [k6 Cloud](https://k6.io/cloud/)
