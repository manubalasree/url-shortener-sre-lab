# ArgoCD Applications

This directory contains all ArgoCD Application manifests for the URL Shortener SRE Lab. Applications are organized by their role in the architecture and deployed in a specific order to handle dependencies.

## Overview

All applications follow GitOps principles and are automatically synced by ArgoCD. Each application:
- Has `automated: prune` and `selfHeal` enabled
- Includes proper finalizers for cleanup
- Uses standardized retry configuration (5 attempts)
- Creates its own namespace automatically

## Application Inventory

### Infrastructure Layer

| Application | Namespace | Source | Purpose | Status |
|-------------|-----------|--------|---------|--------|
| **cert-manager** | cert-manager | Helm (jetstack) | TLS certificate management | ✅ Active |
| **vault** | vault | Helm (HashiCorp) | Secrets management | ✅ Active |

### Operators Layer

| Application | Namespace | Source | Purpose | Status |
|-------------|-----------|--------|---------|--------|
| **postgres-operator** | postgres-operator | Git (Crunchy Data) | PostgreSQL operator | ✅ Active |
| **redis-operator** | redis-operator | Helm (Spotahome) | Redis operator | ⚠️ Deployed (not used) |
| **kiali-operator** | observability | Helm (Kiali) | Service mesh visualization | ✅ Active |
| **external-secrets** | external-secrets-system | Helm | Sync secrets from Vault | ✅ Active |

### Data Layer

| Application | Namespace | Source | Purpose | Status |
|-------------|-----------|--------|---------|--------|
| **postgres-cluster** | postgres | Git (kustomize) | PostgreSQL HA cluster | ✅ Active |
| **redis-cluster** | redis | Git (kustomize) | Redis Sentinel cluster | ⚠️ Deployed (not used) |
| **redis-secret** | redis | Git (kustomize) | Redis secrets | ⚠️ Deployed (not used) |

### Application Layer

| Application | Namespace | Source | Purpose | Status |
|-------------|-----------|--------|---------|--------|
| **shlink** | shlink | Git (kustomize) | URL shortener application | ✅ Active |

### Observability Layer

| Application | Namespace | Source | Purpose | Status |
|-------------|-----------|--------|---------|--------|
| **prometheus-stack** | observability | Helm (Prometheus Community) | Metrics & monitoring | ✅ Active |
| **jaeger** | observability | Git (kustomize) | Distributed tracing | ✅ Active |
| **istio-telemetry** | istio-system | Git (kustomize) | Istio tracing configuration | ✅ Active |

## Deployment Order

Applications should be deployed in this order to respect dependencies:

```
1. Infrastructure
   └── cert-manager
   └── vault

2. Operators
   └── postgres-operator
   └── redis-operator
   └── external-secrets

3. Data Layer
   └── postgres-cluster (waits for postgres-operator)
   └── redis-cluster (waits for redis-operator)

4. Observability (can run in parallel)
   ├── prometheus-stack
   ├── jaeger
   └── kiali-operator

5. Service Mesh
   └── istio-telemetry

6. Application
   └── shlink (waits for postgres, vault, external-secrets)
```

**Note**: ArgoCD's `syncWaves` or `sync-options` can be used to enforce this order if needed.

## Application Details

### cert-manager
**Purpose**: Manages TLS certificates for the cluster
**Why**: Required for webhook certificates and future TLS termination
**Dependencies**: None
**Notes**: Keeps CRDs on deletion

### vault
**Purpose**: Centralized secrets management
**Why**: Stores database credentials and API keys securely
**Dependencies**: None
**Notes**:
- Requires manual initialization and unsealing
- Uses file storage (10Gi)
- See `docs/SESSION-SUMMARY.md` for setup steps

### postgres-operator
**Purpose**: Manages PostgreSQL clusters
**Why**: Automates PostgreSQL HA deployment and lifecycle
**Dependencies**: None
**Notes**: Uses ServerSideApply for CRD management

### postgres-cluster
**Purpose**: Shlink's primary database
**Why**: Persistent storage for URL mappings and analytics
**Dependencies**: postgres-operator
**Notes**:
- HA cluster with automated backups
- Requires manual schema permissions grant
- 20Gi storage

### external-secrets
**Purpose**: Syncs secrets from Vault to Kubernetes
**Why**: GitOps-friendly secret management
**Dependencies**: vault
**Notes**: Uses ServerSideApply

### redis-operator
**Purpose**: Manages Redis clusters
**Why**: Provides Redis HA capabilities
**Dependencies**: None
**Status**: ⚠️ **Deployed but NOT in use**
**Notes**:
- Infrastructure ready for future caching
- Not integrated with Shlink due to Predis library compatibility issues
- Uses ServerSideApply

### redis-cluster
**Purpose**: Redis Sentinel cluster for caching
**Why**: High-availability caching layer
**Dependencies**: redis-operator
**Status**: ⚠️ **Deployed but NOT in use**
**Notes**:
- 3 Redis replicas + 3 Sentinel replicas
- Not integrated with Shlink (Predis compatibility)
- See `docs/03-shlink-integration.md` for details

### redis-secret
**Purpose**: Redis connection credentials
**Dependencies**: redis-cluster
**Status**: ⚠️ **Deployed but NOT in use**
**Notes**: Part of unused Redis infrastructure

### shlink
**Purpose**: URL shortener application (3 replicas)
**Why**: Core application
**Dependencies**: postgres-cluster, vault, external-secrets
**Notes**:
- Accessible via Istio ingress (http://192.168.2.242)
- Gets DB credentials from Vault via External Secrets
- Has Istio sidecar injected

### prometheus-stack
**Purpose**: Monitoring and metrics stack
**Why**: Collects and stores metrics from all components
**Dependencies**: None
**Notes**:
- Includes Prometheus, Grafana, node-exporter, kube-state-metrics
- Grafana: http://192.168.2.242:3000 (admin/admin)
- Prometheus: 10Gi storage, 7-day retention
- Grafana: 5Gi storage
- Pre-configured with Istio dashboards

### jaeger
**Purpose**: Distributed tracing backend
**Why**: Trace requests across services for debugging
**Dependencies**: None
**Notes**:
- All-in-one deployment
- UI: http://192.168.2.242:16686
- Receives traces from Istio

### kiali-operator
**Purpose**: Service mesh visualization
**Why**: Visual representation of traffic flow and service health
**Dependencies**: prometheus-stack, jaeger
**Notes**:
- UI: http://192.168.2.242:20001
- Anonymous auth enabled
- Monitors all namespaces

### istio-telemetry
**Purpose**: Configure Istio tracing to Jaeger
**Why**: Enable distributed tracing for all services
**Dependencies**: jaeger
**Notes**:
- 100% sampling (for testing)
- Uses Job to patch Istio mesh config
- Requires pod restart to take effect

## Common Patterns

### Finalizers
All applications include:
```yaml
metadata:
  finalizers:
    - resources-finalizer.argocd.argoproj.io
```
This ensures proper cascading deletion when removing applications.

### Retry Configuration
All applications use standardized retry:
```yaml
retry:
  limit: 5
  backoff:
    duration: 5s
    factor: 2
    maxDuration: 3m
```

### ServerSideApply
Operators use `ServerSideApply` for CRD management:
- postgres-operator
- redis-operator
- external-secrets

### Status Ignoring
Operator-managed resources ignore status changes:
```yaml
ignoreDifferences:
  - group: <operator-group>
    kind: <CustomResource>
    jqPathExpressions:
      - .status
```

## Managing Applications

### Deploy All Applications
```bash
# Apply all applications
kubectl apply -f kubernetes/argocd/apps/

# Watch sync status
watch kubectl get app -n argocd
```

### Deploy Individual Application
```bash
kubectl apply -f kubernetes/argocd/apps/<app-name>.yaml
```

### Force Sync
```bash
# Via kubectl
kubectl -n argocd patch app <app-name> --type merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# Via argocd CLI
argocd app sync <app-name> --grpc-web
```

### Delete Application
```bash
# This will delete both the ArgoCD app AND all deployed resources (due to finalizer)
kubectl delete -f kubernetes/argocd/apps/<app-name>.yaml
```

### Check Application Health
```bash
# List all apps
kubectl get app -n argocd

# Detailed status
kubectl describe app <app-name> -n argocd

# Sync status only
kubectl get app <app-name> -n argocd -o jsonpath='{.status.sync.status}'
```

## Troubleshooting

### Application OutOfSync
```bash
# Check what's different
kubectl get app <app-name> -n argocd -o yaml

# Force hard refresh
argocd app sync <app-name> --force --grpc-web
```

### Application Degraded
```bash
# Check pod status in target namespace
kubectl get pods -n <namespace>

# Check application events
kubectl describe app <app-name> -n argocd | grep -A 20 Events
```

### Operator Applications Failing
If operator applications (postgres-operator, redis-operator, external-secrets) fail:
1. Check if CRDs are installed: `kubectl get crd`
2. Verify ServerSideApply is working
3. Check operator pod logs: `kubectl logs -n <operator-namespace> deployment/<operator>`

### Secret Sync Issues
If external-secrets fails to sync:
1. Check Vault is unsealed: `kubectl exec -n vault vault-0 -- vault status`
2. Verify SecretStore: `kubectl get secretstore -n shlink`
3. Check ExternalSecret: `kubectl describe externalsecret -n shlink postgres-credentials`

## Inactive Applications (Future Use)

The following applications are deployed but not currently in use:

- **redis-operator**: Infrastructure for future caching
- **redis-cluster**: Sentinel cluster ready for integration
- **redis-secret**: Connection credentials ready

**Why not remove?** These are kept deployed to:
1. Validate HA Redis deployment works
2. Keep infrastructure ready for future Shlink integration
3. Demonstrate operator pattern

**To enable Redis**, see `docs/03-shlink-integration.md` for compatibility requirements.

## Adding New Applications

Use the template in this directory (`_template.yaml`) as a starting point:

```bash
# Copy template
cp kubernetes/argocd/apps/_template.yaml kubernetes/argocd/apps/my-new-app.yaml

# Edit with your application details
# Apply
kubectl apply -f kubernetes/argocd/apps/my-new-app.yaml
```

## Best Practices

1. **Always use Git as source of truth**: No manual `kubectl apply` to managed resources
2. **Test in dev first**: Validate changes before promoting to production
3. **Use semantic versions for Helm charts**: Avoid `latest` tags
4. **Document dependencies**: Update this README when adding apps
5. **Monitor sync status**: Set up alerts for OutOfSync applications
6. **Use health checks**: Leverage ArgoCD health assessment
7. **Tag releases**: Use Git tags for application version tracking

## Related Documentation

- `docs/01-architecture-decision-record.md` - Architectural decisions
- `docs/02-implementation-roadmap.md` - Implementation plan
- `docs/03-shlink-integration.md` - Shlink setup and Redis compatibility
- `docs/04-observability-stack.md` - Observability configuration
- `docs/SESSION-SUMMARY.md` - Current state and manual steps

## Support

For issues or questions:
1. Check ArgoCD UI for sync status
2. Review application logs in target namespace
3. Check this README for troubleshooting steps
4. See SESSION-SUMMARY.md for known issues
