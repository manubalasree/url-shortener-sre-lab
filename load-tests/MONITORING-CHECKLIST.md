# Load Testing Monitoring Checklist

Use this checklist while running load tests to ensure comprehensive monitoring and data collection.

## Pre-Test Checklist

### System Health
- [ ] All Shlink pods are running and healthy: `kubectl get pods -n shlink`
- [ ] PostgreSQL is healthy: `kubectl get pods -n postgres`
- [ ] Istio gateway is running: `kubectl get pods -n istio-system`
- [ ] Observability stack is running: `kubectl get pods -n observability`
- [ ] Health endpoint responds: `curl http://192.168.2.242/rest/health`

### Monitoring Tools Ready
- [ ] Grafana dashboard open: http://192.168.2.242:3000
  - Navigate to: Kubernetes / Compute Resources / Pod
  - Select namespace: `shlink`
- [ ] Kiali open: http://192.168.2.242:20001
  - Graph tab visible
  - Auto-refresh enabled (15s interval)
- [ ] Jaeger open: http://192.168.2.242:16686
  - Ready to search service: `shlink.shlink`
- [ ] Terminal with kubectl access ready

### Environment Setup
- [ ] k6 installed: `k6 version`
- [ ] BASE_URL set: `echo $BASE_URL`
- [ ] SHLINK_API_KEY set: `echo ${SHLINK_API_KEY:0:10}...`
- [ ] Results directory exists: `ls -la load-tests/results/`
- [ ] Disk space available: `df -h`

### Documentation Ready
- [ ] Notepad/doc for observations
- [ ] Screenshot tool ready
- [ ] System metrics baseline recorded

## During Test Monitoring

### In k6 Terminal
Watch for these key indicators:

**Good Signs** ✅:
- [ ] Steady request rate matching test scenario
- [ ] http_req_duration p95 within thresholds
- [ ] http_req_failed rate near 0%
- [ ] No error messages in output
- [ ] Checks passing (green checkmarks)

**Warning Signs** ⚠️:
- [ ] Increasing error rate
- [ ] Degrading response times
- [ ] Check failures
- [ ] Connection timeout messages

**Critical Issues** ❌:
- [ ] High error rate (>5%)
- [ ] Test failures
- [ ] Connection refused errors
- [ ] Script errors

### In Grafana

#### Kubernetes / Compute Resources / Pod Dashboard
Monitor these metrics:

**CPU Usage**:
- [ ] Current CPU usage per pod: _______%
- [ ] CPU trend: Stable / Increasing / Spiking
- [ ] Any pods hitting CPU limits? Yes / No
- [ ] Any pods being throttled? Yes / No

**Memory Usage**:
- [ ] Current memory usage per pod: _______MB
- [ ] Memory trend: Stable / Increasing / Spiking
- [ ] Any pods hitting memory limits? Yes / No
- [ ] Any OOMKilled pods? Yes / No

**Network I/O**:
- [ ] Receive bandwidth: _______MB/s
- [ ] Transmit bandwidth: _______MB/s
- [ ] Network errors: Yes / No

#### Istio Dashboard (if available)
- [ ] Request rate matches k6 output
- [ ] 4xx error rate: _______%
- [ ] 5xx error rate: _______%
- [ ] p95 latency: _______ms
- [ ] p99 latency: _______ms

#### PostgreSQL Dashboard (if available)
- [ ] Active connections: _______
- [ ] Connection pool utilization: _______%
- [ ] Query duration p95: _______ms
- [ ] Slow queries detected? Yes / No

### In Kiali

**Service Graph**:
- [ ] Traffic flowing from istio-ingressgateway → shlink
- [ ] Traffic flowing from shlink → postgresql
- [ ] All edges green (healthy)? Yes / No
- [ ] Any red/orange edges? Yes / No
- [ ] Request rate visible on edges? Yes / No

**Application Health**:
- [ ] Shlink health: Green / Yellow / Red
- [ ] PostgreSQL health: Green / Yellow / Red
- [ ] Error rate on graph: _______%

**Traffic Animation**:
- [ ] Enable traffic animation
- [ ] Observe traffic patterns
- [ ] Note any traffic imbalances
- [ ] Screenshot interesting patterns

### In Jaeger

During the test, collect sample traces:

**Fast Requests** (for baseline):
- [ ] Find a fast successful request (< 100ms)
- [ ] Note the trace ID: _______________________
- [ ] Screenshot the trace
- [ ] Observe span breakdown:
  - Ingress gateway time: _______ms
  - Shlink application time: _______ms
  - Database query time: _______ms

**Slow Requests** (if any):
- [ ] Find slowest request in sample
- [ ] Note the trace ID: _______________________
- [ ] Screenshot the trace
- [ ] Identify bottleneck span: _______________________
- [ ] Root cause: Database / Network / Application / Other

**Error Traces** (if any):
- [ ] Find failed request
- [ ] Note the trace ID: _______________________
- [ ] Screenshot the error
- [ ] Error type: _______________________
- [ ] Error location: _______________________

### System-Level Monitoring

**Kubernetes Events**:
```bash
kubectl get events -n shlink --watch
```
- [ ] Any pod restarts? Yes / No
- [ ] Any scheduling issues? Yes / No
- [ ] Any resource pressure? Yes / No

**Pod Logs** (in separate terminal):
```bash
kubectl logs -n shlink deployment/shlink --tail=50 -f
```
- [ ] Error messages? Yes / No
- [ ] Warning messages? Yes / No
- [ ] Database connection errors? Yes / No
- [ ] Timeout errors? Yes / No

**Resource Usage**:
```bash
kubectl top pods -n shlink
```
- [ ] Pod 1 - CPU: _______% | Memory: _______Mi
- [ ] Pod 2 - CPU: _______% | Memory: _______Mi
- [ ] Pod 3 - CPU: _______% | Memory: _______Mi

## Post-Test Checklist

### Immediate Review
- [ ] Test completed successfully? Yes / No
- [ ] All thresholds passed? Yes / No
- [ ] Results saved to JSON file: _______________________
- [ ] Summary exported: _______________________

### Results Analysis
- [ ] Review k6 summary output
- [ ] Note key metrics:
  - Total requests: _______
  - Request rate: _______/s
  - p95 latency: _______ms
  - p99 latency: _______ms
  - Error rate: _______%
  - Success rate: _______%

### System State After Test
- [ ] All pods still healthy? Yes / No
- [ ] Any pods restarted during test? Yes / No
- [ ] Resource usage returned to normal? Yes / No
- [ ] Any errors in logs? Yes / No

### Data Collection
- [ ] Screenshot k6 summary
- [ ] Screenshot Grafana metrics during peak load
- [ ] Screenshot Kiali service graph during test
- [ ] Export interesting Jaeger traces
- [ ] Copy kubectl top output
- [ ] Save any error logs

### Observations and Notes

**Performance Observations**:
_______________________________________________________
_______________________________________________________
_______________________________________________________

**Bottlenecks Identified**:
_______________________________________________________
_______________________________________________________
_______________________________________________________

**Unexpected Behaviors**:
_______________________________________________________
_______________________________________________________
_______________________________________________________

**System Resilience**:
_______________________________________________________
_______________________________________________________
_______________________________________________________

### Comparison with Targets

#### Scenario 1: Baseline
| Metric | Target | Achieved | Pass/Fail |
|--------|--------|----------|-----------|
| Request Rate | > 15 req/s | _______ | _____ |
| p95 Latency | < 200ms | _______ | _____ |
| p99 Latency | < 500ms | _______ | _____ |
| Error Rate | < 1% | _______ | _____ |

#### Scenario 2: Peak Hours
| Metric | Target | Achieved | Pass/Fail |
|--------|--------|----------|-----------|
| Request Rate | > 40 req/s | _______ | _____ |
| p95 Latency | < 300ms | _______ | _____ |
| p99 Latency | < 1000ms | _______ | _____ |
| Error Rate | < 2% | _______ | _____ |

#### Scenario 3: Viral Event
| Metric | Target | Achieved | Pass/Fail |
|--------|--------|----------|-----------|
| Request Rate | > 75 req/s | _______ | _____ |
| p95 Latency | < 500ms | _______ | _____ |
| p99 Latency | < 2000ms | _______ | _____ |
| Error Rate | < 5% | _______ | _____ |

### Action Items

**Immediate Actions Needed**:
- [ ] _______________________________________________________
- [ ] _______________________________________________________
- [ ] _______________________________________________________

**Optimizations to Consider**:
- [ ] _______________________________________________________
- [ ] _______________________________________________________
- [ ] _______________________________________________________

**Further Investigation Required**:
- [ ] _______________________________________________________
- [ ] _______________________________________________________
- [ ] _______________________________________________________

### Next Steps
- [ ] Wait 10 minutes for system to stabilize
- [ ] Review all collected data
- [ ] Document findings in test report
- [ ] Update SESSION-SUMMARY.md
- [ ] Plan next test or optimizations
- [ ] Share results with team (if applicable)

## Test Report Template

After completing all tests, use this template:

```markdown
# Load Test Results - [Date]

## Environment
- k6 Version: _______
- Shlink Version: _______
- Kubernetes Version: _______
- Number of Shlink Replicas: _______

## Test Summary

### Scenario 1: Baseline
- Status: PASS / FAIL
- Duration: 10 minutes
- Key Findings: _______

### Scenario 2: Peak Hours
- Status: PASS / FAIL
- Duration: 5 minutes
- Key Findings: _______

### Scenario 3: Viral Event
- Status: PASS / FAIL
- Duration: 10 minutes
- Key Findings: _______

## Overall Performance
- Best p95 latency: _______ms (Scenario ___)
- Worst p95 latency: _______ms (Scenario ___)
- Maximum sustained req/s: _______
- System breaking point: _______ req/s

## Bottlenecks Identified
1. _______
2. _______
3. _______

## Recommendations
1. _______
2. _______
3. _______

## Attached Evidence
- [ ] k6 JSON results
- [ ] Grafana screenshots
- [ ] Kiali service graphs
- [ ] Jaeger trace samples
- [ ] kubectl outputs
```

---

**Remember**: The goal is not just to run tests, but to understand system behavior under load and identify areas for improvement.
