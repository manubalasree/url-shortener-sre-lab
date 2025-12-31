# Istio Telemetry Configuration

This directory contains Istio telemetry configuration to enable distributed tracing and observability.

## What This Does

1. **Enables Distributed Tracing**: Configures Istio to send traces to Jaeger
2. **100% Sampling**: Captures all requests for testing (adjust for production)
3. **Access Logging**: Enables envoy access logs to stdout
4. **Custom Tags**: Adds environment and cluster tags to traces

## Components

### telemetry.yaml
Defines the Telemetry resource that configures:
- Jaeger as the tracing provider
- 100% sampling rate for testing
- Access logging to envoy stdout

### configmap.yaml (Optional)
Contains mesh-wide configuration for:
- Extension providers (Jaeger connection details)
- Global tracing settings
- Access log format

**Note**: This configmap may conflict with existing Istio installation. It's provided for reference but not included in kustomization by default.

## Deployment

### Via ArgoCD (Recommended)
```bash
kubectl apply -f ../../argocd/apps/istio-telemetry.yaml
```

### Via kubectl
```bash
kubectl apply -k .
```

## Configuration Details

### Jaeger Integration
- **Service**: `jaeger-collector.observability.svc.cluster.local`
- **Port**: 9411 (Zipkin compatible)
- **Protocol**: Zipkin over HTTP

### Sampling Rate
- **Current**: 100% (all requests traced)
- **Production Recommendation**: 1-10% to reduce overhead

```yaml
randomSamplingPercentage: 100.0  # Change to 1.0 or 10.0 for production
```

### Custom Tags
Each trace includes:
- `environment: k3s-lab`
- `cluster: url-shortener`

## Verification

After applying, verify tracing is enabled:

```bash
# Check telemetry resource
kubectl get telemetry -n istio-system

# Restart pods to pick up new configuration
kubectl rollout restart deployment -n shlink shlink

# Generate test traffic
curl http://192.168.2.242/rest/health

# Check Jaeger for traces
# Open: http://192.168.2.242:16686
# Service: shlink.shlink
```

## Troubleshooting

### No traces appearing in Jaeger

1. **Verify Jaeger collector is running**:
```bash
kubectl get pods -n observability | grep jaeger-collector
```

2. **Check Telemetry resource is applied**:
```bash
kubectl get telemetry -n istio-system mesh-default -o yaml
```

3. **Verify Istio proxy is receiving configuration**:
```bash
kubectl logs -n shlink deployment/shlink -c istio-proxy | grep -i trace
```

4. **Check Jaeger collector logs**:
```bash
kubectl logs -n observability deployment/jaeger -c jaeger
```

5. **Restart application pods**:
```bash
kubectl rollout restart deployment -n shlink shlink
```

### Kiali not showing traffic

Kiali reads from Prometheus metrics. Ensure:
1. Traffic is actively flowing (run load tests)
2. Prometheus is scraping Istio metrics
3. Refresh Kiali graph (it shows recent 1-5 minutes)

```bash
# Generate continuous traffic
for i in {1..100}; do curl -s http://192.168.2.242/ > /dev/null; sleep 1; done
```

## Production Considerations

### Sampling Rate
Reduce sampling to 1-10% in production:

```yaml
randomSamplingPercentage: 1.0  # 1% sampling
```

### Performance Impact
- 100% sampling adds ~1-2ms latency per request
- 1% sampling adds <0.1ms latency per request
- Storage requirements scale with sampling rate

### Storage Requirements
With 100% sampling at 1000 RPS:
- ~86 million traces per day
- ~500GB storage per day (uncompressed)

Recommended for production:
- 1% sampling = ~5GB storage per day
- 7-day retention = ~35GB total

## Related Resources

- [Istio Telemetry API](https://istio.io/latest/docs/reference/config/telemetry/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [Kiali Documentation](https://kiali.io/docs/)

## Changes Required After Applying

1. **Restart application pods** to inject new trace configuration
2. **Generate traffic** to see traces
3. **Wait 1-2 minutes** for traces to propagate to Jaeger UI

## Rollback

To disable tracing:

```bash
kubectl delete telemetry mesh-default -n istio-system
kubectl rollout restart deployment -n shlink shlink
```
