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
- Custom tags (environment, cluster)

### configmap-patch-job.yaml
Kubernetes Job that patches the Istio mesh configmap to add extension providers:
- Runs as ArgoCD PostSync hook
- Adds Jaeger and Envoy extension providers to Istio mesh config
- Uses RBAC (ServiceAccount, Role, RoleBinding) for security
- Auto-deletes after successful completion

**Why a Job?**
- Istio's configmap is managed by Helm and reverts manual changes
- IstioOperator CRD doesn't exist in this installation
- Job-based patching is GitOps-friendly and idempotent

## Deployment

### Via ArgoCD (Recommended)
```bash
kubectl apply -f ../../argocd/apps/istio-telemetry.yaml
```

This will:
1. Create the Telemetry resource
2. Run the configmap patch job
3. Configure Istio to send traces to Jaeger

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

# Check extension providers in mesh config
kubectl get configmap istio -n istio-system -o yaml | grep -A 10 extensionProviders

# Restart pods to pick up new configuration
kubectl rollout restart deployment -n shlink shlink

# Generate test traffic
for i in {1..20}; do curl http://192.168.2.242/rest/health; sleep 1; done

# Check Jaeger for traces
# Open: http://192.168.2.242:16686
# Service: istio-ingressgateway.istio-system or shlink.shlink
```

## Troubleshooting

### No traces appearing in Jaeger

1. **Verify extension providers are configured**:
```bash
kubectl get configmap istio -n istio-system -o yaml | grep -A 5 extensionProviders
```
Should show `jaeger` provider with correct service address.

2. **Check Telemetry resource is applied**:
```bash
kubectl get telemetry -n istio-system mesh-default -o yaml
```

3. **Verify Jaeger collector is running**:
```bash
kubectl get pods -n observability | grep jaeger-collector
kubectl get svc -n observability jaeger-collector
```

4. **Check if Job ran successfully**:
```bash
kubectl get events -n istio-system --sort-by='.lastTimestamp' | grep mesh-config
```

5. **Manually trigger the patch job** (if needed):
```bash
kubectl delete job istio-mesh-config-patcher -n istio-system
kubectl apply -k .
```

6. **Restart application pods**:
```bash
kubectl rollout restart deployment -n shlink shlink
```

### Kiali not showing traffic

Kiali reads from Prometheus metrics. Ensure:
1. Traffic is actively flowing (run load tests)
2. Prometheus is scraping Istio metrics
3. Refresh Kiali graph (shows recent 1-5 minutes)

```bash
# Generate continuous traffic
for i in {1..100}; do curl -s http://192.168.2.242/rest/health > /dev/null; sleep 1; done
```

### Job fails or patch doesn't apply

If the patch job fails:
```bash
# Check job logs
kubectl logs -n istio-system job/istio-mesh-config-patcher

# Verify RBAC permissions
kubectl get role,rolebinding -n istio-system | grep mesh-config-patcher

# Manual patch (temporary - not GitOps)
kubectl patch configmap istio -n istio-system --type merge -p '{"data":{"mesh":"..."}}'
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

## Files in This Directory

```
istio-telemetry/
├── README.md                    # This file
├── kustomization.yaml           # Kustomize manifest
├── telemetry.yaml              # Telemetry resource (tracing config)
└── configmap-patch-job.yaml    # Job to patch Istio mesh config
```

## Related Resources

- [Istio Telemetry API](https://istio.io/latest/docs/reference/config/telemetry/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [Kiali Documentation](https://kiali.io/docs/)

## Changes Required After Applying

1. **Wait for ArgoCD sync** (automatic if auto-sync enabled)
2. **Wait for Job to complete** (patches configmap)
3. **Restart application pods** to inject new trace configuration
4. **Generate traffic** to see traces
5. **Wait 1-2 minutes** for traces to propagate to Jaeger UI

## Rollback

To disable tracing:

```bash
# Delete telemetry resource
kubectl delete telemetry mesh-default -n istio-system

# Restart pods
kubectl rollout restart deployment -n shlink shlink
```

Note: The extension providers will remain in the configmap until manually removed or Istio is reinstalled.
