# Implementation Roadmap

**Project:** URL Shortener - SRE Learning Lab
**Author:** Manu B Sreekumari
**Created:** December 27, 2024
**Last Updated:** December 30, 2024
**Status:** In Progress (Phases 1-5 Complete)

## Overview

This document provides a step-by-step implementation guide for building the URL shortener homelab project. Each phase includes specific tasks, validation checkpoints, and expected outcomes.

## Environment Specifications

**Physical Hardware:**
- Minisforum UM790 Pro (64GB RAM, Proxmox hypervisor)

**VM Configuration (3 nodes):**
- OS: Ubuntu 24.04 LTS
- RAM: 10GB per VM
- vCPU: 4 cores per VM
- Disk: 100GB per VM
- Network: Bridge mode (DHCP via home router)

**IP Address Assignments:**
- k3s-node-01: 192.168.2.242
- k3s-node-02: 192.168.2.243
- k3s-node-03: 192.168.2.244
- Gateway: 192.168.2.1
- DNS: 192.168.2.1 (home router)
- **Reserved Range:** 192.168.2.242-244 (K3s cluster nodes)

**K3s Cluster Topology:**
- **Decision:** 3 control plane nodes with embedded etcd (HA)
- **Status:** ✓ Cluster operational (v1.33.6+k3s1)
- **Installed:** December 27, 2024

**GitOps Tooling:**
- **ArgoCD:** ✓ Installed and operational
- **Deployment Strategy:** GitOps-based (all manifests deployed via ArgoCD)
- **Repository:** GitHub (url-shortener-sre-lab)

## Phase 1: Infrastructure Foundation

**Goal:** Create a working K3s cluster with GitOps tooling ready for application deployments.

### Step 1.1: Proxmox VM Preparation

**What to do:**
1. In Proxmox UI, create 3 VMs with specifications above
2. Name them: `k3s-node-01`, `k3s-node-02`, `k3s-node-03`
3. Download Ubuntu 24.04 LTS Server ISO to Proxmox
4. Install Ubuntu 24.04 on each VM:
   - Use minimal installation (no GUI)
   - Set hostnames to match VM names
   - Configure static IPs (record them for later use)
   - Enable SSH during installation
   - Create consistent user account across all nodes

**Validation checklist:**
- [ ] All 3 VMs boot successfully
- [ ] Can SSH into each VM from your workstation
- [ ] Each VM has static IP configured
- [ ] Hostnames are set correctly (`hostname` command shows expected name)
- [ ] VMs can ping each other by IP address
- [ ] VMs can reach internet (test: `ping 8.8.8.8`)
- [ ] DNS resolution works (test: `ping google.com`)

**Expected outcome:**
3 clean Ubuntu VMs, networked, accessible via SSH, ready for K3s installation.

---

### Step 1.2: System Preparation

**What to do on EACH VM:**

1. Update system packages
2. Disable swap (K8s requirement)
3. Configure kernel parameters for K8s
4. Install required dependencies
5. Sync time across nodes (NTP)
6. Set up firewall rules for K3s

**Validation checklist:**
- [ ] System packages are up to date
- [ ] Swap is disabled (`free -h` shows 0 swap)
- [ ] Kernel modules loaded correctly
- [ ] Firewall allows K3s ports (6443, 8472, 10250, etc.)
- [ ] Time is synchronized across all nodes (`timedatectl` shows synced)
- [ ] No conflicting services running on K3s ports

**Expected outcome:**
All nodes prepared for K3s installation with clean baseline.

---

### Step 1.3: K3s Cluster Installation

**Decision point:** Choose cluster topology (3 control planes vs 1+2 workers).

**What to do:**

**If 3 control plane nodes (recommended):**
1. Install K3s on first node as primary server
2. Get token from first node
3. Join second and third nodes as server nodes (HA)
4. Verify embedded etcd cluster is healthy

**If 1 control + 2 workers:**
1. Install K3s on first node as server
2. Get token from server node
3. Join second and third nodes as agents (workers)

**Validation checklist:**
- [ ] K3s service running on all nodes (`systemctl status k3s` or `k3s-agent`)
- [ ] kubectl works from control plane: `kubectl get nodes`
- [ ] All nodes show as Ready state
- [ ] Default namespace exists: `kubectl get namespaces`
- [ ] Can create test pod: `kubectl run nginx --image=nginx`
- [ ] Test pod starts successfully
- [ ] Can access pod: `kubectl exec -it nginx -- curl localhost`
- [ ] Clean up test pod: `kubectl delete pod nginx`

**Expected outcome:**
Fully functional K3s cluster with all nodes in Ready state.

---

### Step 1.4: Storage and Networking Validation

**What to do:**

1. Verify local-path storage provisioner is running
2. Create a test PVC (Persistent Volume Claim)
3. Validate CNI (Flannel) networking between pods
4. Test DNS resolution within cluster
5. Disable/replace default Traefik (we're using Istio)

**Validation checklist:**
- [ ] Storage class exists: `kubectl get storageclass`
- [ ] Can create PVC: Test with simple StatefulSet
- [ ] Pod-to-pod networking works across nodes
- [ ] CoreDNS is running: `kubectl get pods -n kube-system | grep coredns`
- [ ] DNS works: Pod can resolve `kubernetes.default.svc.cluster.local`
- [ ] Traefik disabled (no conflicts with future Istio ingress)

**Expected outcome:**
Cluster has working storage and networking, ready for application workloads.

---

### Step 1.5: ArgoCD Installation (GitOps Foundation)

**What to do:**

1. Install ArgoCD using official manifests
2. Expose ArgoCD UI via NodePort for homelab access
3. Get initial admin password
4. Install ArgoCD CLI on workstation
5. Login to ArgoCD server
6. Configure git repository connection

**Installation commands:**

```bash
# Create namespace
kubectl create namespace argocd

# Install ArgoCD
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Wait for pods
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=argocd-server -n argocd --timeout=300s

# Expose via NodePort
kubectl patch svc argocd-server -n argocd -p '{"spec": {"type": "NodePort"}}'

# Get password
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d

# Get NodePort
kubectl get svc argocd-server -n argocd
```

**Validation checklist:**
- [ ] All ArgoCD pods running: `kubectl get pods -n argocd`
- [ ] argocd-server, argocd-repo-server, argocd-application-controller Ready
- [ ] Can access UI via browser: `https://192.168.2.242:<nodeport>`
- [ ] ArgoCD CLI installed on workstation: `argocd version`
- [ ] Can login via CLI: `argocd login <server>:<port>`
- [ ] Repository connection tested

**Expected outcome:**
ArgoCD operational, ready to deploy applications via GitOps workflow.

---

## Phase 2: Stateful Services Deployment (via ArgoCD)

**Goal:** Deploy PostgreSQL and Redis using GitOps methodology.

**Deployment Approach:**
All services deployed as ArgoCD Applications pointing to manifests in git repository.

### Step 2.1: PostgreSQL Operator Installation

**Decision:** Using Crunchy PostgreSQL Operator (PGO) for production-like database management.

**What to do:**

1. Create ArgoCD Application for PGO operator installation
2. Point to remote kustomize: `https://github.com/CrunchyData/postgres-operator/config`
3. Deploy operator to `postgres-operator` namespace
4. Verify operator is running and watching cluster

**ArgoCD Application manifest:**
Location: `kubernetes/argocd/apps/postgres-operator.yaml`

**Validation checklist:**
- [ ] Operator deployed via ArgoCD Application
- [ ] Application shows "Synced" and "Healthy" in ArgoCD UI
- [ ] Operator pod running: `kubectl get pods -n postgres-operator`
- [ ] CRDs installed: `kubectl get crd | grep postgres`
- [ ] Operator logs show no errors

**Expected outcome:**
Crunchy PGO operator operational, ready to manage PostgresCluster resources.

---

### Step 2.2: PostgreSQL Cluster Deployment

**What to do:**

1. Ensure kustomize manifests exist in `kubernetes/kustomize/postgres/`
   - postgres.yaml: PostgresCluster resource
   - kustomization.yaml: namespace and resources
2. Create ArgoCD Application pointing to local git repository
3. Configure automated sync policy
4. Monitor deployment via ArgoCD UI

**PostgresCluster configuration:**
- Name: `shlink-db`
- Version: PostgreSQL 18
- User: `shlink`
- Database: `shlink`
- Storage: 20Gi data + 20Gi backups
- Namespace: `postgres`

**ArgoCD Application manifest:**
Location: `kubernetes/argocd/apps/postgres-cluster.yaml`

**Validation checklist:**
- [ ] ArgoCD Application created and synced
- [ ] PostgreSQL pods running: `kubectl get pods -n postgres`
- [ ] Pods: shlink-db-instance1-xxxx, shlink-db-repo-host-x
- [ ] PVCs bound: `kubectl get pvc -n postgres`
- [ ] Can connect: `kubectl exec -it shlink-db-instance1-xxxx -n postgres -- psql -U shlink shlink`
- [ ] Database and user auto-created by operator
- [ ] Credentials secret exists: `kubectl get secret -n postgres | grep shlink-db`

**Expected outcome:**
Production-grade PostgreSQL cluster running, managed by PGO, deployed via GitOps.

---

### Step 2.2: Redis Cluster Deployment

**What to do:**

1. Create namespace: `redis`
2. Choose deployment method:
   - **Option A:** Redis operator (Redis Enterprise, Spotahome)
   - **Option B:** StatefulSet for Redis cluster (3 masters + 3 replicas)
   - **Option C:** Single Redis instance for MVP (simplest)
3. Configure persistence (AOF or RDB snapshots)
4. Set memory limits and eviction policy (`allkeys-lru`)
5. Test cluster connectivity and failover

**Validation checklist:**
- [ ] Redis pod(s) running and Ready
- [ ] Can connect: `kubectl exec -it <pod> -- redis-cli ping` returns PONG
- [ ] Can write data: `SET test_key test_value`
- [ ] Can read data: `GET test_key` returns `test_value`
- [ ] Persistence works (restart pod, verify key exists)
- [ ] Memory limit enforced: `kubectl exec -it <pod> -- redis-cli INFO memory`
- [ ] Eviction policy configured: `CONFIG GET maxmemory-policy`

**Expected outcome:**
Redis cache layer operational with configured persistence and eviction.

---

## Phase 3: Shlink Application Deployment

**Goal:** Deploy Shlink URL shortener connected to Postgres and Redis.

### Step 3.1: Shlink Configuration

**What to do:**

1. Create namespace: `shlink`
2. Review Shlink documentation for environment variables
3. Create ConfigMap for non-sensitive configuration
4. Create Secret for API keys and sensitive data
5. Configure connection strings for Postgres and Redis
6. Set up initial admin API key

**Validation checklist:**
- [ ] ConfigMap created with app configuration
- [ ] Secret created with database credentials and API keys
- [ ] Connection strings correctly reference Postgres and Redis services
- [ ] Configuration validated against Shlink docs

**Expected outcome:**
Shlink configuration ready for deployment.

---

### Step 3.2: Shlink Deployment

**What to do:**

1. Create Deployment manifest for Shlink
2. Configure resource requests/limits (memory, CPU)
3. Set replica count (start with 2 for basic HA)
4. Mount ConfigMap and Secret as environment variables
5. Expose via ClusterIP Service (Istio will handle ingress)
6. Deploy and monitor startup logs

**Validation checklist:**
- [ ] Shlink pods start successfully
- [ ] Logs show successful database connection
- [ ] Logs show successful Redis connection
- [ ] Health check endpoint responds: `/rest/health`
- [ ] Can create test short URL via API
- [ ] Can retrieve short URL from API
- [ ] URL resolves and redirects correctly
- [ ] Redis cache is being populated (check keys in Redis)

**Expected outcome:**
Shlink running, creating URLs, using cache, storing in database.

---

## Phase 4: Istio Service Mesh

**Goal:** Add traffic management, mTLS, and observability via Istio.

### Step 4.1: Istio Installation

**What to do:**

1. Download and install `istioctl` CLI tool
2. Install Istio with demo profile (includes ingress, egress, telemetry)
3. Enable sidecar injection for Shlink namespace
4. Redeploy Shlink to get Envoy sidecars
5. Verify sidecar injection worked

**Validation checklist:**
- [ ] Istio control plane running: `kubectl get pods -n istio-system`
- [ ] Istiod is healthy
- [ ] Ingress gateway pod running
- [ ] Sidecar injection enabled: `kubectl get namespace shlink -o yaml` shows label
- [ ] Shlink pods have 2 containers (app + istio-proxy)
- [ ] Can still access Shlink API (test previous functionality)

**Expected outcome:**
Istio installed, Shlink pods have sidecars, basic functionality preserved.

---

### Step 4.2: Istio Traffic Management

**What to do:**

1. Create Gateway resource for external access
2. Create VirtualService for Shlink routing
3. Create DestinationRule for load balancing policies
4. Configure rate limiting at ingress
5. Set up timeout and retry policies

**Validation checklist:**
- [ ] Gateway created and listener active
- [ ] VirtualService routes traffic to Shlink service
- [ ] Can access Shlink via Istio ingress gateway
- [ ] Rate limiting works (test with high request volume)
- [ ] Timeouts configured: Test with slow backend
- [ ] Retries work: Test with intermittent failures

**Expected outcome:**
Production-grade traffic management with rate limiting and resilience patterns.

---

### Step 4.3: Istio mTLS and Security

**What to do:**

1. Enable strict mTLS for all services
2. Create PeerAuthentication policy
3. Create AuthorizationPolicy (only Shlink can access Redis/Postgres)
4. Verify encrypted communication between pods

**Validation checklist:**
- [ ] mTLS enabled: `istioctl authn tls-check <pod>`
- [ ] Traffic between pods is encrypted
- [ ] Authorization policies enforced (test unauthorized access fails)
- [ ] Shlink can still access Redis and Postgres
- [ ] External traffic to ingress still works

**Expected outcome:**
Zero-trust networking with automatic mTLS between all services.

---

## Phase 5: Observability Stack

**Goal:** Add monitoring, logging, and tracing for full system visibility.

### Step 5.1: Prometheus and Grafana

**What to do:**

1. Install Prometheus (scrape Istio metrics, K3s metrics, app metrics)
2. Install Grafana with pre-built Istio dashboards
3. Configure Prometheus to scrape:
   - Istio control plane
   - Envoy sidecars
   - Shlink application metrics (if exposed)
   - Redis exporter
   - Postgres exporter
4. Set up key dashboards:
   - RED metrics (Rate, Errors, Duration)
   - Service mesh topology
   - Resource utilization

**Validation checklist:**
- [ ] Prometheus scraping all targets successfully
- [ ] Grafana accessible via browser
- [ ] Istio dashboards showing traffic
- [ ] Can see request rate, error rate, latency for Shlink
- [ ] Redis and Postgres metrics visible
- [ ] Alerts configured for critical thresholds

**Expected outcome:**
Real-time visibility into system health and performance.

---

### Step 5.2: Distributed Tracing (Jaeger)

**What to do:**

1. Install Jaeger for distributed tracing
2. Configure Istio to send traces to Jaeger
3. Generate sample traffic through Shlink
4. View trace spans across services

**Validation checklist:**
- [ ] Jaeger UI accessible
- [ ] Traces appear in Jaeger for Shlink requests
- [ ] Can see full request path: Ingress → Shlink → Redis/Postgres
- [ ] Latency breakdown visible per service
- [ ] Can identify slow queries or cache misses in traces

**Expected outcome:**
Complete request flow visibility for debugging and optimization.

---

## Phase 6: Performance Testing and Validation

**Goal:** Validate architecture meets performance targets from ADR.

### Step 6.1: Load Testing Setup

**What to do:**

1. Choose load testing tool (k6, Locust, hey, wrk)
2. Create test scenarios:
   - **Scenario 1:** URL creation (write-heavy)
   - **Scenario 2:** URL redirection (read-heavy, cache hit)
   - **Scenario 3:** URL redirection (read-heavy, cache miss)
   - **Scenario 4:** Mixed workload (100:1 read:write ratio)
3. Set up monitoring during tests

**Validation checklist:**
- [ ] Load testing tool installed and working
- [ ] Test scripts created for all scenarios
- [ ] Baseline performance recorded with no load
- [ ] Can generate sustained load (1K, 5K, 10K RPS)

**Expected outcome:**
Reproducible load testing framework.

---

### Step 6.2: Performance Measurement

**What to do:**

1. Run each scenario and record metrics:
   - **Latency:** P50, P95, P99
   - **Throughput:** Requests per second
   - **Error rate:** Percentage of failed requests
   - **Resource utilization:** CPU, memory per component
2. Compare against ADR targets:
   - Redirect latency <10ms P99 (cache hit)
   - Cache hit ratio >95%
   - Redis latency 200-500μs
   - Postgres write latency ~5-10ms P99
3. Identify bottlenecks using Grafana and Jaeger

**Validation checklist:**
- [ ] Metrics collected for all scenarios
- [ ] Performance targets met or gaps documented
- [ ] Cache hit ratio measured and optimized
- [ ] Bottlenecks identified (CPU, memory, network, disk I/O)
- [ ] Istio overhead quantified (compare with/without mesh)

**Expected outcome:**
Real performance data to update ADR, clear understanding of system limits.

---

## Phase 7: Documentation and Interview Prep

**Goal:** Document lessons learned and prepare interview talking points.

### Step 7.1: Update ADR with Real Data

**What to do:**

1. Update "Performance Characteristics" sections in ADR with measured data
2. Add "Lessons Learned" to each architectural decision
3. Document what worked well vs what was challenging
4. Capture optimization opportunities discovered

**Expected outcome:**
ADR reflects real-world implementation experience, not just theory.

---

### Step 7.2: Create Runbooks

**What to do:**

1. Document common operations:
   - How to scale Shlink replicas
   - How to backup/restore Postgres
   - How to flush Redis cache
   - How to update Istio routing rules
2. Document troubleshooting procedures:
   - Debugging high latency
   - Investigating cache misses
   - Analyzing distributed traces
   - Checking mTLS connectivity issues

**Expected outcome:**
Operational documentation demonstrating SRE production thinking.

---

### Step 7.3: Prepare Interview Narratives

**What to do:**

1. Practice explaining architecture decisions (refer to ADR)
2. Prepare to walk through traffic flow (draw diagram from memory)
3. Document failure scenarios and how system responds
4. Create talking points for trade-offs made
5. Prepare demo: Show live system, generate traffic, show metrics

**Expected outcome:**
Confident discussion of design, implementation, and operational experience.

---

## Current Status Tracker

| Phase | Status | Completion Date | Notes |
|-------|--------|-----------------|-------|
| Phase 1.1: VM Preparation | ✅ Complete | 2024-12-27 | 3 VMs created with Ubuntu 24.04, IPs: 242-244 |
| Phase 1.2: System Prep | ✅ Complete | 2024-12-27 | All nodes updated, swap disabled, kernel configured |
| Phase 1.3: K3s Installation | ✅ Complete | 2024-12-27 | 3-node HA cluster with embedded etcd |
| Phase 1.4: Storage/Network | ✅ Complete | 2024-12-27 | local-path storage, Flannel CNI, Traefik disabled |
| Phase 1.5: ArgoCD Setup | ✅ Complete | 2024-12-28 | ArgoCD installed, root-app deployed |
| Phase 2.1: PostgreSQL Operator | ✅ Complete | 2024-12-28 | Crunchy PGO v6.0.0 via ArgoCD |
| Phase 2.2: PostgreSQL Cluster | ✅ Complete | 2024-12-28 | shlink-db deployed, 20Gi storage |
| Phase 2.3: Redis | ✅ Complete | 2024-12-30 | Redis Sentinel with 3 replicas, HA configured |
| Phase 3.1: Shlink Config | ✅ Complete | 2024-12-30 | External Secrets Operator with AWS Secrets Manager |
| Phase 3.2: Shlink Deploy | ✅ Complete | 2024-12-30 | Shlink deployed, verified DB connection |
| Phase 4.1: Istio Install | ✅ Complete | 2024-12-30 | Istio 1.24.2, default profile, sidecar injection enabled |
| Phase 4.2: Istio Traffic Mgmt | ✅ Complete | 2024-12-30 | Gateway and VirtualService configured for Shlink |
| Phase 4.3: Istio Security | Not Started | | mTLS not yet enabled |
| Phase 5.1: Prometheus/Grafana | ✅ Complete | 2024-12-30 | kube-prometheus-stack, Grafana on port 3000 |
| Phase 5.2: Jaeger Tracing | ✅ Complete | 2024-12-30 | Jaeger all-in-one, integrated with Istio |
| Phase 6.1: Load Test Setup | Not Started | | |
| Phase 6.2: Performance Measurement | Not Started | | |
| Phase 7.1: Update ADR | Not Started | | |
| Phase 7.2: Runbooks | Not Started | | |
| Phase 7.3: Interview Prep | Not Started | | |

---

## Decision Log

Track decisions made during implementation that weren't covered in original ADR:

| Date | Decision | Rationale | Impact |
|------|----------|-----------|--------|
| 2024-12-27 | Ubuntu 24.04 selected | Latest LTS, good K8s support | Baseline established |
| 2024-12-27 | Shlink confirmed as app | Per ADR, avoid building from scratch | Faster to production |
| 2024-12-27 | K3s: 3 control planes (HA) | Better for SRE learning, HA experience | Production-like setup |
| 2024-12-27 | Network: Bridge mode, static IPs | Simplest for homelab access | Easy demo/testing access |
| 2024-12-28 | GitOps: ArgoCD with app-of-apps | Modern deployment pattern | Full GitOps workflow |
| 2024-12-28 | PostgreSQL: Crunchy PGO operator | Production-grade, auto-management | Operator experience gained |
| 2024-12-28 | Postgres fork used | Control over operator version | Can customize if needed |
| 2024-12-30 | Redis: Sentinel topology | Simpler than cluster, adequate HA | Master-replica with auto-failover |
| 2024-12-30 | External Secrets Operator | Kubernetes-native secret management | Eliminates manual secret copying |
| 2024-12-30 | AWS Secrets Manager | Cloud-native, secure, auditable | Better than local vault for demo |
| 2024-12-30 | Istio service mesh | Zero-code observability, traffic mgmt | Auto-instrumentation for metrics/traces |
| 2024-12-30 | Istio 1.24.2 default profile | Balanced features without bloat | Production-ready configuration |
| 2024-12-30 | kube-prometheus-stack | Industry standard monitoring | Prometheus + Grafana in one package |
| 2024-12-30 | Grafana on port 3000 | Avoid LoadBalancer port conflicts | Port 80 already used by Istio |
| 2024-12-30 | Kiali for mesh visualization | Best-in-class service mesh UI | Real-time topology and traffic flow |
| 2024-12-30 | Jaeger via Kustomize (not operator) | Operator had RBAC issues | Simple all-in-one deployment works |
| 2024-12-30 | All observability via GitOps | Consistency with platform approach | Everything in ArgoCD |

---

## Next Immediate Actions

**YOU ARE HERE: Phase 6 - Performance Testing**

**Completed So Far:**
- ✅ 3-node K3s HA cluster operational (Phase 1)
- ✅ ArgoCD GitOps platform deployed (Phase 1)
- ✅ PostgreSQL operator and cluster running (Phase 2)
- ✅ Redis Sentinel with HA configured (Phase 2)
- ✅ External Secrets Operator with AWS integration (Phase 3)
- ✅ Shlink application deployed and verified (Phase 3)
- ✅ Istio service mesh with traffic management (Phase 4)
- ✅ Complete observability stack deployed (Phase 5)
  - Prometheus & Grafana for metrics
  - Kiali for service mesh visualization
  - Jaeger for distributed tracing
  - cert-manager for certificate management

**Next Steps:**
1. **Phase 6.1: Load Testing Setup** - Prepare performance test environment
   - Install k6 or Grafana K6 operator
   - Create load test scenarios for URL shortening and redirection
   - Define performance baselines and targets

2. **Phase 6.2: Performance Measurement** - Execute and analyze tests
   - Run baseline tests
   - Analyze metrics in Grafana
   - Review traces in Jaeger for bottlenecks
   - Document performance characteristics

3. **Phase 7: Documentation & Interview Prep**
   - Update Architecture Decision Record (ADR)
   - Create operational runbooks
   - Prepare demo and talking points

**Estimated Progress: ~85% Complete (Phases 1-5 done, Phase 6-7 remaining)**
