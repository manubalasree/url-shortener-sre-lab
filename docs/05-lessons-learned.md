# Lessons Learned: URL Shortener SRE Lab

**Project**: URL Shortener SRE Lab
**Author**: Manu B Sreekumari
**Last Updated**: December 30, 2024
**Status**: Phase 6 Complete

## Overview

This document consolidates key lessons learned throughout the URL Shortener SRE Lab project, from initial K3s cluster setup through complete observability stack deployment and performance testing. These insights are organized by technical domain to help future implementers avoid common pitfalls and understand architectural trade-offs.

## Table of Contents

1. [Infrastructure and Platform](#infrastructure-and-platform)
2. [Data Layer](#data-layer)
3. [Application Deployment](#application-deployment)
4. [Service Mesh and Traffic Management](#service-mesh-and-traffic-management)
5. [Observability](#observability)
6. [GitOps and Operations](#gitops-and-operations)
7. [Performance Testing](#performance-testing)
8. [General SRE Practices](#general-sre-practices)

---

## Infrastructure and Platform

### K3s Resource Efficiency Enables Complex Homelab Deployments

**Context**: Running a full production-like stack on a single physical host (Minisforum UM790 Pro with 64GB RAM).

**Learning**: K3s's lightweight footprint (512MB control plane vs 2-3GB for standard Kubernetes) made it possible to run a 3-node HA cluster with Istio, PostgreSQL, Redis, and full observability stack without resource starvation.

**Impact**:
- 3-node cluster overhead: ~1.5GB total
- Left ~60GB RAM for application workloads
- Standard Kubernetes would have consumed 6-9GB just for control plane

**Recommendation**: For homelab SRE learning, K3s hits the sweet spot between production-representative patterns and resource constraints.

### LoadBalancer Port Conflicts Require Planning

**Issue**: MetalLB cannot bind multiple LoadBalancer services to the same port on the same IP pool.

**What Happened**:
- Grafana initially configured on port 80 (LoadBalancer)
- Conflict with Istio ingress gateway (also port 80)
- K3s couldn't assign LoadBalancer IP to Grafana
- Service remained in pending state

**Solution**:
- Moved Grafana to port 3000
- Documented all LoadBalancer port assignments upfront
- Port planning: Istio (80), ArgoCD (30080), Grafana (3000), Kiali (20001), Jaeger (16686)

**Key Takeaway**: Plan LoadBalancer port assignments before deployment to avoid conflicts and service disruptions.

---

## Data Layer

### PostgreSQL Permissions Are Not Automatic with Operators

**Issue**: Crunchy Data Operator creates PostgreSQL users but doesn't grant schema permissions by default.

**Error Encountered**:
```
SQLSTATE[42501]: Insufficient privilege: 7 ERROR: permission denied for schema public
```

**Root Cause**: PostgreSQL 15+ removed default CREATE privileges on the public schema for security reasons. Operators create users but don't grant these permissions automatically.

**Solution Applied**:
```bash
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -d shlink -c "GRANT ALL ON SCHEMA public TO shlink;"
```

**Better Long-Term Solution**: Create a Kubernetes Job to automate this:
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: grant-shlink-permissions
  annotations:
    argocd.argoproj.io/hook: PostSync
spec:
  template:
    spec:
      containers:
      - name: grant-permissions
        image: postgres:16
        command:
        - psql
        - -h
        - shlink-db-primary.postgres.svc.cluster.local
        - -U
        - postgres
        - -d
        - shlink
        - -c
        - "GRANT ALL ON SCHEMA public TO shlink;"
```

**Impact**: Database migrations will fail without this step. Always include post-provisioning permissions in your deployment workflow.

### Redis Architecture Modes Are Not Interchangeable

**Critical Learning**: Sentinel mode ≠ Cluster mode ≠ Standalone mode.

**Key Differences**:

| Mode | Use Case | Sharding | Failover | `cluster_enabled` |
|------|----------|----------|----------|-------------------|
| Standalone | Single instance | No | No | 0 |
| Sentinel | Master-replica HA | No | Yes | 0 |
| Cluster | Distributed data | Yes | Yes | 1 |

**What Went Wrong**:
- Deployed Redis with Spotahome Operator in Sentinel mode (`cluster_enabled:0`)
- Shlink uses Predis library which assumes Cluster mode when given multiple servers
- Predis sent `CLUSTER SLOTS` command → Redis replied with error (not in cluster mode)
- Application startup failed with: `No connections left in the pool for CLUSTER SLOTS`

**Attempted Workarounds**:
1. Multiple servers → Predis assumed Cluster mode (failed)
2. Single master server → `NOSCRIPT` errors on failover (failed)
3. Sentinel configuration → Symfony Cache component couldn't parse Sentinel responses (failed)

**Root Cause**: Client library (Predis) doesn't properly support Sentinel mode in Shlink's configuration.

**Impact**: Redis remained deployed but disconnected. Application runs successfully with PostgreSQL only (no caching).

**Future Solutions**:
1. Deploy true Redis Cluster (6+ nodes, `cluster_enabled:1`)
2. Use phpredis extension instead of Predis (requires custom Docker image)
3. Use single Redis instance with operator-managed failover
4. Accept Predis limitations and use PostgreSQL-only mode

**Key Takeaway**: Match your Redis deployment architecture to your client library's capabilities. Test integration early before committing to an architecture.

### StatefulSet Pods Need Headless Services for DNS Resolution

**Issue**: Applications couldn't resolve individual Redis pod names.

**Error**:
```
getaddrinfo for rfr-shlink-redis-0.redis.svc.cluster.local failed
```

**Root Cause**: StatefulSet pods only get individual DNS records when a headless service exists.

**DNS Pattern Requirements**:
- Without headless service: No individual pod DNS
- With headless service: `<pod-name>.<headless-service>.<namespace>.svc.cluster.local`

**Solution**: Created headless service:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: rfr-shlink-redis
  namespace: redis
spec:
  clusterIP: None  # Headless service
  selector:
    app.kubernetes.io/name: redis-failover
    app.kubernetes.io/component: redis
  ports:
  - port: 6379
    targetPort: 6379
    name: redis
```

**Result**: Pods became addressable as `rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local:6379`

**Key Takeaway**: Always create headless services for StatefulSets when individual pod addressing is needed.

---

## Application Deployment

### External Secrets Operator Requires Proper RBAC Chain

**Learning**: ESO authentication with Vault requires a complete RBAC chain.

**Required Components**:
1. ServiceAccount in target namespace
2. Vault role bound to that ServiceAccount name and namespace
3. Vault policy granting read access to secret paths
4. Kubernetes token reviewer permissions
5. Vault Kubernetes auth method configured with cluster CA and service account token

**Common Failure Points**:
- ServiceAccount name mismatch between Kubernetes and Vault role
- Namespace restrictions in Vault role
- Missing token reviewer JWT in Vault config
- Incorrect secret paths in Vault policy

**Debug Strategy** (work backwards from error):
1. Check ExternalSecret status: `kubectl describe externalsecret -n <namespace> <name>`
2. Check ESO logs: `kubectl logs -n external-secrets deployment/external-secrets`
3. Verify SecretStore connectivity: `kubectl get secretstore -n <namespace>`
4. Test Vault auth manually from within cluster
5. Validate Vault policy and role configuration

**Key Takeaway**: Document the entire auth chain and test each component independently.

### Health Checks Should Match Application Startup Sequence

**Learning**: Shlink's startup sequence provided clear indicators of readiness.

**Startup Phases**:
1. `db:create` → Database creation
2. `db:migrate` → Schema migrations (can take 30+ seconds)
3. `orm:generate-proxies` → Doctrine ORM setup
4. `orm:clear-cache:metadata` → Cache initialization
5. `RoadRunner server started` → Web server ready
6. `/rest/health` endpoint returns 200

**Proper Probe Configuration**:
```yaml
livenessProbe:
  httpGet:
    path: /rest/health
    port: 8080
  initialDelaySeconds: 30  # Allow time for migrations
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /rest/health
    port: 8080
  initialDelaySeconds: 10  # Faster detection
  periodSeconds: 5
```

**Impact**:
- Too short `initialDelaySeconds` → pods killed during migration
- No readiness probe → traffic sent to pods still migrating
- Wrong endpoint → healthy pods marked unhealthy

**Key Takeaway**: Match probe timing to application startup duration and use application-provided health endpoints.

---

## Service Mesh and Traffic Management

### Istio Zero-Instrumentation Observability is Transformative

**Achievement**: Complete distributed tracing and metrics without touching application code.

**What Istio Provided Automatically**:
- Request/response metrics (latency, throughput, errors)
- Distributed trace header injection (x-b3-traceid, x-b3-spanid)
- Service topology auto-discovery
- mTLS between services
- Access logs with full request context

**Impact**:
- Zero code changes to Shlink
- Instant visibility into request flow
- P50/P95/P99 latency metrics out of the box
- Trace correlation across services

**Latency Overhead**:
- Measured: 3-5ms P50 added per hop
- Acceptable for learning environment
- Still achieved <10ms redirect target

**Key Takeaway**: Service mesh observability is a force multiplier for SRE work. The operational overhead is worth the visibility gained.

### Istio Mesh Config Requires Extension Providers for Tracing

**Issue**: Telemetry resource existed but Jaeger showed no traces.

**Root Cause**: Istio mesh config (managed by Helm) was missing `extensionProviders` configuration.

**What Was Needed**:
```yaml
extensionProviders:
- name: jaeger
  opentelemetry:
    service: jaeger-collector.observability.svc.cluster.local
    port: 4317
```

**Challenge**: Helm manages the Istio configmap with `operator.istio.io/managed: Reconcile` label, so manual patches get reverted.

**Solution**: Created Kubernetes Job with ArgoCD PostSync hook to patch configmap programmatically:
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: patch-istio-mesh-config
  annotations:
    argocd.argoproj.io/hook: PostSync
spec:
  template:
    spec:
      serviceAccountName: istio-config-patcher
      containers:
      - name: kubectl
        image: bitnami/kubectl:latest
        command:
        - /bin/sh
        - -c
        - |
          kubectl patch configmap istio -n istio-system --type=json \
            -p '[{"op":"add","path":"/data/mesh","value":"extensionProviders:..."}]'
```

**Key Takeaway**: When Helm manages resources, use Jobs or operators for automated configuration changes instead of manual patches.

---

## Observability

### Prometheus ServiceMonitors Require Specific Label Selectors

**Issue**: Grafana Istio dashboards showed "No data" despite Envoy sidecars exposing metrics.

**Investigation**:
- Pods had `prometheus.io/scrape: "true"` annotations
- Metrics endpoints existed on pods (`:15020/stats/prometheus`)
- But Prometheus wasn't scraping them

**Root Cause**: kube-prometheus-stack uses ServiceMonitor/PodMonitor discovery, NOT annotation-based scraping.

**Configuration Check**:
```yaml
# Prometheus config
serviceMonitorSelector: {}  # Empty selector
# This means: Only match ServiceMonitors with NO labels, OR with release label
```

**Solution**: Created ServiceMonitors with `release: prometheus-stack` label:
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: istiod
  namespace: istio-system
  labels:
    release: prometheus-stack  # Critical label
spec:
  selector:
    matchLabels:
      app: istiod
  endpoints:
  - port: http-monitoring
    interval: 30s
```

**Created Three Monitors**:
1. `servicemonitor-istiod` → Control plane metrics
2. `servicemonitor-ingressgateway` → Gateway metrics
3. `podmonitor-envoy-stats` → All Envoy sidecars across namespaces

**Result**: Grafana dashboards populated with P50/P95/P99 metrics immediately.

**Key Takeaway**: Understand your Prometheus Operator's selector configuration. Don't assume annotations work - use ServiceMonitors/PodMonitors.

### Jaeger In-Memory Storage is NOT Production-Ready

**Issue**: Traces disappear on Jaeger pod restart.

**Why**: All-in-one Jaeger deployment uses in-memory storage by default.

**Impact**:
- Historical trace analysis impossible
- Troubleshooting limited to live traffic
- No long-term performance trending

**Production Solution**: Use persistent backend:
- Elasticsearch (recommended for scale)
- Cassandra (for very high volume)
- Badger with persistent volume (for small deployments)

**Our Choice**: Kept in-memory for simplicity in learning environment.

**Key Takeaway**: Evaluate storage strategy based on retention requirements. In-memory is fine for learning, unacceptable for production.

### ArgoCD Has CRD Size Limitations

**Issue**: Prometheus Operator CRDs failed to install via ArgoCD.

**Error**:
```
metadata.annotations: Too long: may not be more than 262144 bytes
```

**Root Cause**:
- ArgoCD uses client-side apply with annotation-based tracking
- Prometheus Operator v0.79+ has massive CRD schemas (extensive validation)
- ArgoCD's annotation limit is 262KB
- CRDs exceeded this limit

**Impact**: Without CRDs, Prometheus CR couldn't be created, breaking entire metrics pipeline.

**Solution**:
```bash
# Apply CRDs with server-side apply (bypasses ArgoCD)
kubectl apply --server-side -f https://raw.githubusercontent.com/.../crds.yaml
```

**Why This Works**:
- Server-side apply handled by Kubernetes API server
- No annotation processing
- ArgoCD can then manage the Prometheus CR (which references CRD)

**Alternative Solutions**:
1. Use ArgoCD's `Replace=true` sync option
2. Manage CRDs separately from operator deployment
3. Use ArgoCD's `ServerSideApply=true` feature (newer versions)

**Key Takeaway**: Large CRDs (Prometheus, Cert-Manager) may require server-side apply. Plan CRD installation strategy separately from operator deployment.

### Helm Chart Service Names Don't Always Match Chart Name

**Issue**: Kiali couldn't connect to Prometheus or Grafana despite correct namespace.

**Root Cause**: `kube-prometheus-stack` Helm chart creates services with inconsistent naming:

| Expected (by convention) | Actual Service Name |
|-------------------------|---------------------|
| `kube-prometheus-stack-prometheus` | `prometheus-stack-kube-prom-prometheus` |
| `kube-prometheus-stack-grafana` | `prometheus-stack-grafana` |
| `kube-prometheus-stack-alertmanager` | `prometheus-stack-kube-prom-alertmanager` |

**Solution**:
```bash
# Discover actual service names
kubectl get svc -n observability | grep prometheus
kubectl get svc -n observability | grep grafana

# Update Kiali config with correct names
external_services:
  prometheus:
    url: http://prometheus-stack-kube-prom-prometheus.observability:9090
  grafana:
    url: http://prometheus-stack-grafana.observability:3000
```

**Key Takeaway**: Never assume service names from Helm chart names. Always verify with `kubectl get svc` and update integration configs accordingly.

### Kiali Integration Requires Exact Port Configuration

**Issue**: Kiali showed "Could not fetch Grafana info" error.

**What Was Wrong**:
- Kiali config had Grafana on port 80
- Actual Grafana service runs on port 3000
- DNS resolution succeeded but connection failed

**Correct Configuration**:
```yaml
external_services:
  grafana:
    url: http://prometheus-stack-grafana.observability:3000  # Not :80
```

**Impact**: Non-critical - Kiali can't embed Grafana dashboard links, but both tools work independently.

**Key Takeaway**: Verify service ports with `kubectl get svc <name> -o yaml`, don't guess based on defaults.

---

## GitOps and Operations

### ArgoCD Auto-Prune Requires GitOps Discipline

**Issue**: Manually applied resources were deleted by ArgoCD during sync.

**Behavior**: ArgoCD with `prune: true` removes resources not in Git source.

**What Happened**:
- Manually applied test resources for troubleshooting
- ArgoCD sync deleted them (considered out of sync)
- Lost work and had to recreate

**Solution**: Always commit resources to Git before applying in cluster.

**Workflow**:
1. Create manifest locally
2. Commit to Git
3. Push to repository
4. ArgoCD auto-syncs OR manual sync via UI/CLI
5. Never use `kubectl apply` for permanent resources

**Emergency Override**:
```yaml
# Add annotation to prevent ArgoCD from managing a resource
metadata:
  annotations:
    argocd.argoproj.io/sync-options: Prune=false
```

**Key Takeaway**: GitOps discipline is non-negotiable with auto-prune. Commit first, deploy second.

### Operators Add Complexity - Use When Value Is Clear

**Experience**: Mixed results with operators.

**Operators That Worked Well**:
- **Crunchy Data Operator**: HA PostgreSQL with automated backups, worth the complexity
- **Kiali Operator**: Simplified Kiali deployment with good defaults
- **External Secrets Operator**: Seamless AWS integration, major value add

**Operators That Caused Issues**:
- **Jaeger Operator**: RBAC issues, complex troubleshooting
  - Solution: Switched to simple Kustomize deployment
  - Result: Deployed in 5 minutes vs hours of debugging

**Decision Framework**:
- Use operator if: Provides HA, lifecycle management, or complex integration
- Use Kustomize if: Simple stateless app, stable configuration, operator adds overhead

**Key Takeaway**: Operators are not always the answer. Evaluate complexity vs value for each use case.

### Directory Organization by Architectural Layer Improves Clarity

**Evolution**: Started with flat ArgoCD apps directory, evolved to layered structure.

**Final Structure**:
```
kubernetes/argocd/apps/
├── infrastructure/     # cert-manager, vault
├── operators/          # postgres-operator, redis-operator, external-secrets, kiali-operator
├── data-layer/         # postgres-cluster, redis-cluster, redis-secret
├── application/        # shlink
└── observability/      # prometheus-stack, jaeger, istio-telemetry, istio-monitoring
```

**Benefits**:
- Clear deployment order (infrastructure → operators → data → app → observability)
- Easy to find related applications
- Natural grouping for documentation
- Reflects dependency graph

**Key Takeaway**: Organize by architectural layer, not alphabetically or by technology.

---

## Performance Testing

### Traffic Modeling Should Be Based on DAU, Not Concurrent Users

**Common Mistake**: Modeling load tests as "X concurrent users".

**Better Approach**: Model based on Daily Active Users (DAU) with realistic usage patterns.

**Example - 1000 DAU Analysis**:

**Write Load**:
- 1000 users × 5 URLs/day = 5,000 URLs daily
- Average: ~0.06 URLs/sec
- Peak hours (8h): ~0.14 URLs/sec
- Viral spike: 5-8 URLs/sec

**Read Load** (100:1 ratio):
- 100× write load = 500,000 redirects daily
- Average: ~6 redirects/sec
- Peak hours: ~17 redirects/sec
- Viral spike: 100-200+ redirects/sec

**Test Scenario Design**:
- Scenario 1 (Baseline): 1 creation/sec, 20 redirects/sec
- Scenario 2 (Peak): 2 creations/sec, 50 redirects/sec
- Scenario 3 (Viral): 5-8 creations/sec, 100-200 redirects/sec

**Key Takeaway**: Model traffic based on user behavior patterns, not arbitrary concurrent user counts. Factor in read/write ratios and peak hour concentration.

### Pareto Principle Applies to URL Traffic

**Observation**: In viral scenarios, 20% of URLs receive 80% of traffic.

**Implementation**:
```javascript
// Viral traffic concentrated on few URLs
const popularUrls = createdUrls.slice(0, Math.floor(createdUrls.length * 0.2));
const selectedUrl = popularUrls[Math.floor(Math.random() * popularUrls.length)];
```

**Impact on Testing**:
- Better cache hit ratio modeling
- Realistic hotspot simulation
- Exposes caching effectiveness

**Key Takeaway**: Model traffic distribution realistically using power law distribution for viral content.

### Performance Tests Should Include Setup Phase

**Learning**: Don't start load test on empty database.

**Better Approach**: Pre-create URLs during setup phase:
```javascript
export function setup() {
  const urls = [];
  for (let i = 0; i < 100; i++) {
    const response = http.post(/* create URL */);
    urls.push(response.json().shortCode);
  }
  return { urls };
}
```

**Benefits**:
- Realistic redirect testing from first iteration
- More accurate cache behavior
- Better P95/P99 measurements

**Key Takeaway**: Include data seeding in your load test setup to match production state.

---

## General SRE Practices

### Start Simple, Add Complexity Incrementally

**Lesson Reinforced Throughout Project**: Every time we tried to deploy multiple components simultaneously, troubleshooting became difficult.

**Successful Pattern**:
1. Deploy component A (e.g., PostgreSQL)
2. Verify health and basic functionality
3. Deploy component B (e.g., Shlink with DB only)
4. Verify integration works
5. Add component C (e.g., Vault for secrets)
6. Verify each integration point

**Failed Attempts**:
- Deploying PostgreSQL + Redis + Vault + Shlink simultaneously
- Result: Unknown which component caused failures
- Wasted hours troubleshooting multi-variable problems

**Key Takeaway**: Isolate variables. Deploy incrementally. Verify at each step. Makes debugging exponential easier.

### Read Application Logs During Initial Deployment

**Lesson**: Application startup logs reveal exactly what's failing.

**Example - Shlink Logs**:
```
db:create → SUCCESS
db:migrate → FAILED: permission denied for schema public
```

**Strategy**:
```bash
# Watch logs during deployment
kubectl logs -n shlink deployment/shlink -f

# Check previous pod logs if current is crashing
kubectl logs -n shlink deployment/shlink --previous
```

**Key Takeaway**: Application logs are your first troubleshooting resource. Monitor during initial deployment.

### Document As You Build, Not After

**What Worked**:
- Created `SESSION-SUMMARY.md` and updated after each major milestone
- Captured decisions and failures in real-time
- Documented commands immediately after running them

**What Would Have Failed**:
- Trying to recreate documentation weeks later
- Forgetting exact error messages and solutions
- Losing context on why decisions were made

**Recommendation**:
- Keep a running session summary document
- Screenshot errors and solutions
- Document "why" not just "what"

**Key Takeaway**: Documentation created in-the-moment is 10x more accurate and valuable than retrospective documentation.

### Health Checks Are Critical for Zero-Downtime Deployments

**Observation**: Proper health checks prevented traffic to unhealthy pods during:
- Database migrations (30+ seconds)
- Application startup (configuration loading)
- Transient failures (temporary DB connection issues)

**Without Health Checks**:
- Traffic sent to pods still migrating → 500 errors
- Rolling updates kill healthy pods before new ones ready → downtime
- Pods with broken config receive traffic → sustained outages

**With Proper Health Checks**:
- Zero-downtime rolling updates
- Automatic pod restart on failures
- Traffic only to truly ready pods

**Key Takeaway**: Invest time in proper liveness and readiness probes. They're foundational to HA.

### Observability Integration Creates Single Pane of Glass

**Achievement**: Kiali → Prometheus → Grafana → Jaeger integration.

**User Flow Example**:
1. Notice high latency in Kiali graph
2. Click through to Grafana dashboard for detailed metrics
3. Identify slow endpoint
4. Click trace sample in Grafana
5. Opens Jaeger with full request breakdown

**Benefit**: Seamless troubleshooting workflow without context switching.

**Configuration Effort**:
- Minimal - mostly DNS names and ports
- High value for low implementation cost

**Key Takeaway**: Integrate observability tools. The whole is greater than sum of parts.

### Infrastructure as Code Enables Rapid Recovery

**Experience**: Accidentally deleted namespace with all observability components.

**Recovery Time**:
- With GitOps: ~5 minutes (ArgoCD re-synced everything)
- Without IaC: Would have taken hours to recreate manually

**What Made This Possible**:
- All configs in Git
- ArgoCD auto-sync enabled
- Declarative manifests (idempotent)

**Key Takeaway**: IaC isn't just best practice - it's disaster recovery insurance.

---

## Summary of Top 10 Most Impactful Lessons

1. **PostgreSQL operators don't grant schema permissions** - Always include post-provisioning permission grants

2. **Redis architecture modes are not interchangeable** - Match deployment to client library capabilities

3. **Istio provides zero-code observability** - Service mesh is transformative for SRE work

4. **Prometheus needs ServiceMonitors, not just annotations** - Understand your operator's discovery mechanism

5. **GitOps discipline is non-negotiable** - Commit to Git before deploying to cluster

6. **Start simple, add complexity incrementally** - Single-variable changes make troubleshooting exponential easier

7. **Traffic modeling should use DAU patterns** - Model realistic user behavior, not concurrent users

8. **Health checks enable zero-downtime deployments** - Invest in proper liveness/readiness probes

9. **Document as you build** - Real-time documentation is 10x more accurate than retrospective

10. **Operators add complexity** - Use when value is clear, prefer simple deployments otherwise

---

## Recommendations for Future Implementations

### Do This First

1. Plan LoadBalancer ports before deployment
2. Document service discovery (DNS names, ports) immediately
3. Set up observability early (don't wait until problems arise)
4. Create operational runbooks as you deploy
5. Test health checks before enabling auto-scaling/auto-healing

### Avoid These Pitfalls

1. Don't assume Helm service names match chart names
2. Don't deploy multiple new integrations simultaneously
3. Don't rely on manual unsealing for production Vault
4. Don't skip the setup phase in load tests
5. Don't trust operators blindly - verify they meet your needs

### Production Readiness Checklist

- [ ] Automated PostgreSQL schema permission grants
- [ ] Persistent Jaeger storage (Elasticsearch/Cassandra)
- [ ] Vault auto-unseal with cloud KMS
- [ ] Prometheus alerting rules configured
- [ ] Grafana dashboards for all critical paths
- [ ] Load test results documented with SLOs
- [ ] Disaster recovery procedures tested
- [ ] Secrets rotation automated
- [ ] Network policies implemented
- [ ] Pod security standards enforced

---

## Conclusion

This URL Shortener SRE Lab project reinforced that production-grade reliability comes from:
- Understanding your infrastructure deeply (not just deploying it)
- Observability from day one (not as an afterthought)
- GitOps discipline (no manual kubectl apply for permanent resources)
- Incremental complexity (start simple, verify, then add)
- Documentation in real-time (capture context while fresh)

The most valuable skill developed was systematic troubleshooting: read logs, check integration points, verify assumptions, isolate variables. This methodical approach worked consistently across database issues, service mesh config, observability integration, and performance testing.

---

**Next Steps**: Apply these lessons to Phase 7 (chaos engineering) and cloud migration to AWS EKS.

**Document Version**: 1.0 (December 30, 2024)
