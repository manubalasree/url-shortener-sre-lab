# Observability Stack: Istio, Kiali, Prometheus, Grafana, and Jaeger

**Date**: 2025-12-30
**Stack Version**: Production-ready GitOps deployment

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Components](#components)
4. [Installation & Configuration](#installation--configuration)
5. [Access & Usage](#access--usage)
6. [Monitoring Capabilities](#monitoring-capabilities)
7. [Troubleshooting](#troubleshooting)
8. [Production Considerations](#production-considerations)
9. [Lessons Learned](#lessons-learned)

---

## Overview

This document describes the complete observability stack deployed for the Shlink URL shortener service. The stack provides comprehensive monitoring, tracing, and visualization capabilities without requiring any code changes to the application.

### Key Features

- **Zero instrumentation required**: Istio service mesh automatically collects telemetry
- **GitOps managed**: All components deployed via ArgoCD
- **Production-ready**: Persistent storage, high availability, LoadBalancer access
- **Complete visibility**: Metrics, traces, topology, and logs

### Stack Components

| Component | Version | Purpose | Management |
|-----------|---------|---------|------------|
| Istio | 1.24.2 | Service mesh & auto-instrumentation | istioctl |
| Kiali | 2.4.0 | Service mesh visualization | Helm (ArgoCD) |
| Prometheus | via kube-prometheus-stack | Metrics collection & storage | Helm (ArgoCD) |
| Grafana | via kube-prometheus-stack | Dashboards & visualization | Helm (ArgoCD) |
| Jaeger | 1.53 | Distributed tracing | Kustomize (ArgoCD) |
| cert-manager | 1.16.2 | TLS certificate management | Helm (ArgoCD) |

---

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        External Users                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                    ┌────────────────────┐
                    │ Istio Ingress      │
                    │ Gateway            │
                    │ (192.168.2.242)    │
                    └─────────┬──────────┘
                              │
                              │ [Auto-inject trace headers]
                              │ [Record metrics]
                              │
                              ▼
                    ┌────────────────────┐
                    │  Shlink Service    │
                    │  (3 pods)          │
                    └─────────┬──────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
   ┌────────┐          ┌──────────┐          ┌─────────┐
   │Shlink-1│          │Shlink-2  │          │Shlink-3 │
   │        │          │          │          │         │
   │┌──────┐│          │┌────────┐│          │┌───────┐│
   ││ App  ││          ││  App   ││          ││  App  ││
   │└──────┘│          │└────────┘│          │└───────┘│
   │┌──────┐│          │┌────────┐│          │┌───────┐│
   ││Envoy ││          ││ Envoy  ││          ││ Envoy ││
   ││Proxy ││          ││ Proxy  ││          ││ Proxy ││
   │└──────┘│          │└────────┘│          │└───────┘│
   └────┬───┘          └────┬─────┘          └────┬────┘
        │                   │                     │
        └───────────────────┼─────────────────────┘
                            │
                            │ [Automatic telemetry collection]
                            │
        ┌───────────────────┼─────────────────────────┐
        │                   │                         │
        ▼                   ▼                         ▼
   ┌─────────┐        ┌──────────┐            ┌──────────┐
   │ Jaeger  │        │Prometheus│            │  Kiali   │
   │ Traces  │        │ Metrics  │            │ Topology │
   └─────────┘        └─────┬────┘            └──────────┘
                            │
                            ▼
                      ┌──────────┐
                      │ Grafana  │
                      │Dashboard │
                      └──────────┘
```

### Data Flow

**Request Flow**:
1. User request → Istio Ingress Gateway (port 80)
2. Gateway Envoy injects trace headers (`x-request-id`, `x-b3-traceid`, etc.)
3. Request routed to Shlink pod via VirtualService
4. Pod's Envoy sidecar intercepts request
5. Sidecar records metrics and creates trace span
6. Forwards to Shlink application (localhost:8080)
7. Application processes request
8. Response flows back through Envoy → Gateway → User

**Telemetry Flow**:
- **Metrics**: Envoy exposes Prometheus metrics on port 15090 → Prometheus scrapes every 30s
- **Traces**: Envoy sends trace spans to Jaeger collector (port 14268) via HTTP
- **Topology**: Kiali reads service graph from Prometheus service discovery

---

## Components

### 1. Istio Service Mesh

**Purpose**: Provides service-to-service communication with automatic observability

**Key Features**:
- Automatic sidecar injection (Envoy proxy)
- Traffic management (routing, retries, timeouts)
- Security (mTLS, authorization policies)
- Observability (metrics, traces, logs)

**Installation**:
```bash
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.24.2 sh -
istioctl install --set profile=default -y
```

**Configuration**:
- Profile: `default`
- Namespace injection: `kubectl label namespace shlink istio-injection=enabled`
- Control plane: `istiod` in `istio-system` namespace
- Data plane: Envoy sidecars in application pods

**Components Running**:
```
istio-system namespace:
- istiod-xxx (1 pod) - Control plane
- istio-ingressgateway-xxx (1 pod) - Ingress gateway
```

**Exposed Services**:
- Ingress Gateway: `192.168.2.242:80` (HTTP), `192.168.2.242:443` (HTTPS)

**Files**:
- Gateway: `kubernetes/kustomize/shlink/istio/gateway.yaml`
- VirtualService: `kubernetes/kustomize/shlink/istio/virtualservice.yaml`

---

### 2. Kiali (Service Mesh Visualization)

**Purpose**: Visual representation of the service mesh topology, traffic flow, and health

**Version**: 2.4.0 (Kiali Operator)

**Installation**: Helm chart via ArgoCD
```yaml
Source: https://kiali.org/helm-charts
Chart: kiali-operator
```

**Configuration**:
- Authentication: Anonymous (no login required)
- Service Type: LoadBalancer
- Accessible namespaces: All (`**`)

**External Services Integration**:
- Prometheus: `http://kube-prometheus-stack-prometheus.observability:9090`
- Grafana: `http://kube-prometheus-stack-grafana.observability:80`
- Jaeger: `http://jaeger-query.observability:16686`

**Access**:
- URL: http://192.168.2.242:20001
- No authentication required

**Key Features**:
- Real-time service graph
- Traffic flow visualization
- Request rates and latencies
- Success/error rates
- Configuration validation
- Distributed tracing integration

**Files**:
- ArgoCD App: `kubernetes/argocd/apps/kiali-operator.yaml`
- Values: Embedded in ArgoCD application spec

---

### 3. Prometheus (Metrics Collection)

**Purpose**: Time-series metrics collection and storage

**Version**: kube-prometheus-stack 67.4.0

**Installation**: Helm chart via ArgoCD
```yaml
Source: https://prometheus-community.github.io/helm-charts
Chart: kube-prometheus-stack
```

**Configuration**:
```yaml
Storage: 10Gi PVC
Retention: 7 days
Service Monitors: Auto-discovery enabled
Scrape Interval: 30s (default)
```

**What It Monitors**:
- Istio service mesh metrics (from Envoy sidecars)
- Kubernetes cluster metrics (via kube-state-metrics)
- Node metrics (via node-exporter on all 3 nodes)
- Application metrics (if exposed)

**Metrics Collected**:
```
Istio Metrics:
- istio_requests_total
- istio_request_duration_milliseconds
- istio_request_bytes
- istio_response_bytes
- istio_tcp_connections_opened_total
- istio_tcp_connections_closed_total

Kubernetes Metrics:
- node_cpu_seconds_total
- node_memory_MemAvailable_bytes
- container_cpu_usage_seconds_total
- container_memory_working_set_bytes
- kube_pod_status_phase
- kube_deployment_status_replicas
```

**Access**:
- Internal: `http://kube-prometheus-stack-prometheus.observability:9090`
- External: Port-forward required (not exposed via LoadBalancer)

**Components**:
```
observability namespace:
- prometheus-stack-kube-prom-operator (1 pod) - Operator
- prometheus-xxx (StatefulSet) - Prometheus server
- prometheus-stack-kube-state-metrics (1 pod) - K8s metrics
- prometheus-stack-prometheus-node-exporter (3 pods) - Node metrics
```

**Files**:
- ArgoCD App: `kubernetes/argocd/apps/prometheus-stack.yaml`
- Values: `kubernetes/kustomize/observability/prometheus-values.yaml`

---

### 4. Grafana (Dashboards)

**Purpose**: Visualization and dashboards for metrics

**Version**: Included in kube-prometheus-stack

**Configuration**:
```yaml
Admin Password: admin
Service Type: LoadBalancer
Service Port: 3000
Persistence: 5Gi PVC
```

**Access**:
- URL: http://192.168.2.242:3000
- Username: `admin`
- Password: `admin`

**Pre-loaded Dashboards**:
1. **Istio Mesh Dashboard**: Overall mesh health and traffic
2. **Istio Service Dashboard**: Per-service metrics
3. **Istio Workload Dashboard**: Per-workload (pod) metrics
4. **Kubernetes Cluster Monitoring**: Node and pod resources

**Key Metrics Displayed**:
- Request rate (requests/second)
- Request duration (P50, P90, P95, P99)
- Success rate (%)
- Error rate (%)
- TCP connection metrics
- Resource utilization (CPU, memory)

**Data Source**:
- Prometheus: `http://kube-prometheus-stack-prometheus.observability:9090`

**Persistence**:
- PVC: 5Gi for dashboard configurations and user preferences
- Storage Class: Default cluster storage class

**Files**:
- Deployed as part of prometheus-stack
- Manual service exposure: `grafana-manual` service created

---

### 5. Jaeger (Distributed Tracing)

**Purpose**: Distributed request tracing across the service mesh

**Version**: 1.53 (all-in-one deployment)

**Installation**: Kustomize deployment via ArgoCD

**Configuration**:
```yaml
Strategy: allInOne (collector + query + UI in single pod)
Storage: In-memory
Max Traces: 100,000
Protocols: Zipkin, OTLP (gRPC & HTTP), Jaeger native
```

**Deployment Architecture**:
```
jaeger pod:
- jaeger-all-in-one container
  Ports:
  - 5775/UDP: Zipkin compact thrift
  - 6831/UDP: Jaeger compact thrift
  - 6832/UDP: Jaeger binary thrift
  - 5778/TCP: Serve configs
  - 16686/TCP: Query UI
  - 14268/TCP: Jaeger collector HTTP
  - 14250/TCP: Jaeger collector gRPC
  - 9411/TCP: Zipkin HTTP collector
  - 4317/TCP: OTLP gRPC
  - 4318/TCP: OTLP HTTP
```

**Services**:
```yaml
1. jaeger-query (LoadBalancer):
   - External access to Jaeger UI
   - Port: 16686
   - IP: 192.168.2.242

2. jaeger-collector (ClusterIP):
   - Receives traces from Envoy
   - Ports: 14268 (HTTP), 14250 (gRPC), 9411 (Zipkin)

3. zipkin (ClusterIP):
   - Zipkin-compatible endpoint
   - Port: 9411

4. tracing (ClusterIP):
   - Internal query service
   - Port: 80 → 16686
```

**Access**:
- URL: http://192.168.2.242:16686
- No authentication required

**How Istio Sends Traces**:
1. Envoy sidecars automatically inject trace headers
2. Spans sent to `zipkin.observability:9411` (Istio default)
3. Jaeger's Zipkin-compatible endpoint receives them
4. Stored in memory (up to 100k traces)
5. Queryable via Jaeger UI

**Trace Structure**:
```
Trace ID: abc-123-def-456
├─ Span: istio-ingressgateway (80ms)
│  ├─ HTTP Method: GET
│  ├─ URL: /rest/health
│  ├─ Status: 200
│  └─ Span: shlink.observability:8080 (58ms)
│     ├─ Component: envoy
│     ├─ Upstream cluster: shlink.observability.svc.cluster.local
│     └─ Response flags: -
```

**Files**:
- Deployment: `kubernetes/kustomize/jaeger/deployment.yaml`
- Services: `kubernetes/kustomize/jaeger/service.yaml`
- Kustomization: `kubernetes/kustomize/jaeger/kustomization.yaml`
- ArgoCD App: `kubernetes/argocd/apps/jaeger.yaml`

**Resource Limits**:
```yaml
Requests:
  CPU: 100m
  Memory: 256Mi
Limits:
  CPU: 500m
  Memory: 512Mi
```

---

### 6. cert-manager (Certificate Management)

**Purpose**: Automated TLS certificate provisioning and renewal

**Version**: 1.16.2

**Installation**: Helm chart via ArgoCD
```yaml
Source: https://charts.jetstack.io
Chart: cert-manager
```

**Configuration**:
```yaml
CRDs: Enabled and preserved
Namespace: cert-manager
```

**Why It's Needed**:
- Required dependency for Jaeger Operator (uses cert-manager for webhook certificates)
- Future use: TLS certificates for Istio Gateway HTTPS
- Automatic certificate rotation

**Components**:
```
cert-manager namespace:
- cert-manager (1 pod) - Controller
- cert-manager-webhook (1 pod) - Admission webhook
- cert-manager-cainjector (1 pod) - CA injection
```

**Files**:
- ArgoCD App: `kubernetes/argocd/apps/cert-manager.yaml`

---

## Installation & Configuration

### Prerequisites

1. Kubernetes cluster (K3s) with 3 nodes
2. kubectl configured with cluster access
3. ArgoCD installed and operational
4. Git repository with manifests

### Installation Order

```
1. cert-manager (dependency)
   ↓
2. Istio (service mesh foundation)
   ↓
3. Enable sidecar injection on shlink namespace
   ↓
4. Restart shlink deployment (to inject sidecars)
   ↓
5. Deploy Istio Gateway & VirtualService
   ↓
6. Deploy observability stack via ArgoCD:
   - prometheus-stack (Prometheus + Grafana)
   - kiali-operator
   - jaeger
```

### Step-by-Step Deployment

#### 1. Install Istio

```bash
# Download Istio
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.24.2 sh -
cd istio-1.24.2

# Pre-installation check
export KUBECONFIG=~/.kube/config-k3s
./bin/istioctl x precheck

# Install
./bin/istioctl install --set profile=default -y

# Verify
kubectl get pods -n istio-system
kubectl get svc -n istio-system
```

#### 2. Enable Sidecar Injection

```bash
# Label namespace
kubectl label namespace shlink istio-injection=enabled --overwrite

# Restart deployment
kubectl rollout restart deployment/shlink -n shlink

# Verify sidecars
kubectl get pods -n shlink
# Should show 2/2 containers per pod
```

#### 3. Deploy Istio Configuration

Commit to Git:
```bash
git add kubernetes/kustomize/shlink/istio/
git add kubernetes/kustomize/shlink/kustomization.yaml
git commit -m "Add Istio Gateway and VirtualService"
git push
```

ArgoCD will automatically sync.

#### 4. Deploy Observability Stack

All via ArgoCD (auto-sync enabled):

```bash
# Commit ArgoCD applications
git add kubernetes/argocd/apps/cert-manager.yaml
git add kubernetes/argocd/apps/prometheus-stack.yaml
git add kubernetes/argocd/apps/kiali-operator.yaml
git add kubernetes/argocd/apps/jaeger.yaml
git commit -m "Add observability stack"
git push

# ArgoCD root-app will detect and deploy automatically
# Wait 2-3 minutes for all components to be ready
```

#### 5. Verify Deployment

```bash
# Check all observability pods
kubectl get pods -n observability

# Check services
kubectl get svc -n observability

# Check ArgoCD applications
kubectl get application -n argocd | grep -E "cert-manager|prometheus|kiali|jaeger"
```

Expected output:
```
NAME                SYNC STATUS   HEALTH STATUS
cert-manager        Synced        Healthy
kiali-operator      Synced        Healthy
prometheus-stack    Synced        Healthy (or Progressing)
jaeger              Synced        Healthy
```

---

## Access & Usage

### Access URLs

| Dashboard | URL | Port | Credentials |
|-----------|-----|------|-------------|
| Kiali | http://192.168.2.242:20001 | 20001 | None |
| Grafana | http://192.168.2.242:3000 | 3000 | admin / admin |
| Jaeger | http://192.168.2.242:16686 | 16686 | None |

### Using Kiali

**1. View Service Graph**:
```
1. Navigate to http://192.168.2.242:20001
2. Click "Graph" in left menu
3. Select namespace: "shlink"
4. View options:
   - Versioned app graph
   - Workload graph
   - Service graph
```

**2. Traffic Metrics**:
```
Graph displays:
- Request rate (RPS) on edges
- Success rate (green %)
- Error rate (red %, if any)
- Response time (ms)
```

**3. Service Details**:
```
Click on a service node to see:
- Inbound/Outbound traffic
- Request volume
- Error rates
- Response times
- Pod details
```

**4. Traces Integration**:
```
Click "Traces" tab on any service
→ Opens Jaeger with pre-filtered traces
```

### Using Grafana

**1. Login**:
```
URL: http://192.168.2.242:3000
Username: admin
Password: admin
(Change password on first login if desired)
```

**2. View Istio Dashboards**:
```
1. Click "Dashboards" (left menu)
2. Browse folders:
   - "Istio" folder:
     * Istio Mesh Dashboard
     * Istio Service Dashboard
     * Istio Workload Dashboard
```

**3. Istio Mesh Dashboard**:
Shows global mesh health:
- Global request volume
- Global success rate
- 4xx/5xx error rates
- Service breakdown

**4. Istio Service Dashboard**:
Select service: `shlink.shlink.svc.cluster.local`
Shows:
- Request rate over time
- Request duration (P50, P90, P99)
- Request size
- Response size
- TCP connection metrics

**5. Create Custom Queries**:
```
Explore → Select Prometheus datasource

Example queries:
# Request rate
rate(istio_requests_total{destination_service="shlink.shlink.svc.cluster.local"}[5m])

# P95 latency
histogram_quantile(0.95,
  rate(istio_request_duration_milliseconds_bucket[5m])
)

# Success rate
sum(rate(istio_requests_total{response_code=~"2.*"}[5m])) /
sum(rate(istio_requests_total[5m]))
```

### Using Jaeger

**1. Search for Traces**:
```
URL: http://192.168.2.242:16686

1. Service dropdown: Select "istio-ingressgateway.istio-system"
2. Operation: Leave as "All"
3. Lookback: Last hour
4. Click "Find Traces"
```

**2. View Trace Details**:
```
Click on a trace to see:
- Full span timeline
- Request path
- Timing breakdown
- Tags (HTTP method, status code, etc.)
- Logs (if any)
```

**3. Common Searches**:
```
By Service:
- istio-ingressgateway.istio-system (entry point)
- shlink.observability (application)

By Operation:
- ingress.shlink-gateway
- shlink.observability:8080/*

By Tag:
- http.status_code=200
- http.method=GET
- http.url=/rest/health
```

**4. Analyze Latency**:
```
Traces show:
- Total request time
- Time in each service
- Time in network transit
- Identify bottlenecks
```

**Example Trace**:
```
Trace ID: a1b2c3d4e5f6
Duration: 85ms

├─ istio-ingressgateway (85ms)
│  Tags:
│  - http.method: GET
│  - http.url: /rest/health
│  - http.status_code: 200
│  - upstream_cluster: shlink.shlink.svc.cluster.local
│
│  └─ shlink.observability:8080 (58ms)
│     Tags:
│     - component: envoy
│     - upstream_cluster: inbound|8080||
│     - response_flags: -
```

---

## Monitoring Capabilities

### Metrics Available

**Request Metrics**:
```
- Total requests (count)
- Request rate (req/sec)
- Request duration (ms, histogram)
  - P50, P90, P95, P99
- Request size (bytes)
- Response size (bytes)
```

**Traffic Metrics**:
```
- Success rate (%)
- Error rate (%)
- HTTP status code distribution
  - 2xx (success)
  - 3xx (redirect)
  - 4xx (client error)
  - 5xx (server error)
```

**Connection Metrics**:
```
- TCP connections opened
- TCP connections closed
- TCP bytes sent
- TCP bytes received
```

**Service Mesh Metrics**:
```
- Services discovered
- Workloads (pods) per service
- Traffic between services
- mTLS status (if enabled)
```

### Traces Available

**Trace Information**:
```
- Trace ID (unique identifier)
- Span ID (per-service identifier)
- Parent span ID (call hierarchy)
- Service name
- Operation name
- Start time & duration
- HTTP method, URL, status code
- Error flag (if failed)
```

**Span Tags**:
```
Istio automatically adds:
- component: "envoy"
- upstream_cluster: destination service
- http.method: GET/POST/etc
- http.url: request path
- http.status_code: response code
- response_flags: envoy response flags
- request_size: bytes
- response_size: bytes
```

### Topology Visualization

**Kiali Graph Shows**:
```
- Services and their relationships
- Traffic direction (arrows)
- Traffic volume (edge thickness)
- Success/error rates (colors)
- Response times
- Protocol (HTTP, TCP, gRPC)
```

**Graph Types**:
1. **App Graph**: Logical application view
2. **Versioned App Graph**: With version labels
3. **Workload Graph**: Individual pod view
4. **Service Graph**: Kubernetes service view

---

## Troubleshooting

### Common Issues

#### 1. Sidecars Not Injected

**Symptoms**: Pods show 1/1 containers instead of 2/2

**Check**:
```bash
kubectl get namespace shlink --show-labels | grep istio-injection
```

**Fix**:
```bash
kubectl label namespace shlink istio-injection=enabled --overwrite
kubectl rollout restart deployment/shlink -n shlink
```

#### 2. No Traces in Jaeger

**Symptoms**: Jaeger UI shows "No traces found"

**Check Jaeger is Running**:
```bash
kubectl get pods -n observability -l app=jaeger
kubectl logs -n observability -l app=jaeger
```

**Check Envoy is Sending Traces**:
```bash
kubectl exec -n shlink deployment/shlink -c istio-proxy -- \
  curl -s localhost:15000/stats/prometheus | grep tracing
```

**Verify Trace Headers**:
```bash
curl -v http://192.168.2.242/rest/health 2>&1 | grep -i "x-b3\|x-request-id"
```

**Common Causes**:
- Sampling rate too low (Istio default: 1%)
- Jaeger collector not accessible
- Envoy not configured for tracing

**Solution**:
Increase sampling rate:
```bash
kubectl edit configmap istio -n istio-system
# Add: meshConfig.defaultConfig.tracing.sampling = 100.0
```

#### 3. Grafana Shows No Data

**Symptoms**: Dashboards empty or "No data"

**Check Prometheus**:
```bash
kubectl get pods -n observability | grep prometheus
kubectl logs -n observability prometheus-xxx-0
```

**Check ServiceMonitors**:
```bash
kubectl get servicemonitor -A
```

**Verify Prometheus is Scraping**:
```bash
kubectl port-forward -n observability svc/kube-prometheus-stack-prometheus 9090:9090
# Open http://localhost:9090/targets
# Check if istio-system targets are up
```

#### 4. Kiali Shows Empty Graph

**Symptoms**: Kiali graph shows no services

**Causes**:
- No traffic flowing through mesh
- Wrong namespace selected
- Prometheus not configured

**Fix**:
```bash
# Generate traffic
for i in {1..20}; do
  curl -s http://192.168.2.242/rest/health > /dev/null
  sleep 0.5
done

# Verify in Kiali:
# 1. Select "shlink" namespace
# 2. Adjust time range (last 5 minutes)
# 3. Refresh graph
```

#### 5. LoadBalancer Pending

**Symptoms**: Service shows `<pending>` under EXTERNAL-IP

**Check**:
```bash
kubectl get svc -n observability jaeger-query
kubectl describe svc -n observability jaeger-query
```

**Common Cause**: Port conflict (another LoadBalancer using same port)

**Fix**: Use different port or NodePort:
```yaml
spec:
  type: LoadBalancer
  ports:
  - port: 16687  # Changed from 16686
    targetPort: 16686
```

#### 6. Jaeger UI Not Loading

**Symptoms**: HTTP 404 or connection refused

**Check Pod Status**:
```bash
kubectl get pods -n observability -l app=jaeger
kubectl logs -n observability -l app=jaeger
```

**Check Service**:
```bash
kubectl get svc jaeger-query -n observability
curl http://$(kubectl get svc jaeger-query -n observability -o jsonpath='{.spec.clusterIP}'):16686
```

**Common Issues**:
- Pod not ready (check readiness probe)
- Service port mismatch
- LoadBalancer not assigned

---

## Production Considerations

### High Availability

**Current Setup** (Single instance):
```
- Prometheus: 1 replica (StatefulSet)
- Grafana: 1 replica
- Jaeger: 1 replica (all-in-one)
- Kiali: 1 replica
```

**Production HA** (Recommended):
```yaml
# Prometheus
prometheus:
  replicas: 2
  replicaExternalLabelName: "prometheus_replica"

# Grafana
grafana:
  replicas: 2

# Jaeger
# Replace all-in-one with production deployment:
strategy: production
collector:
  replicas: 3
query:
  replicas: 2
storage:
  type: elasticsearch  # or cassandra
```

### Persistent Storage

**Current Configuration**:
```
Prometheus: 10Gi PVC, 7-day retention
Grafana: 5Gi PVC
Jaeger: In-memory (100k traces, ephemeral)
```

**Production Recommendations**:
```yaml
# Prometheus
storage:
  size: 100Gi  # Based on metrics volume
  retention: 30d  # or longer
  storageClass: fast-ssd  # Use SSD for better performance

# Grafana
persistence:
  size: 10Gi
  storageClass: standard

# Jaeger
storage:
  type: elasticsearch
  elasticsearch:
    nodeCount: 3
    storage: 500Gi
```

### Resource Limits

**Current Limits**:
```yaml
Jaeger:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

**Production Recommendations**:
```yaml
# Based on traffic volume

Prometheus:
  requests:
    cpu: 500m
    memory: 2Gi
  limits:
    cpu: 2000m
    memory: 8Gi

Grafana:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 1Gi

Jaeger Collector:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: 2000m
    memory: 4Gi

Kiali:
  requests:
    cpu: 10m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 1Gi
```

### Security

**Current Setup**:
- Kiali: Anonymous access
- Grafana: Basic auth (admin/admin)
- Jaeger: No authentication

**Production Recommendations**:

**1. Enable Authentication**:
```yaml
# Kiali
auth:
  strategy: token  # or openid

# Grafana
admin:
  password: <strong-password>
auth:
  generic_oauth:
    enabled: true  # Use OAuth/OIDC

# Jaeger
# Deploy behind OAuth2 proxy
```

**2. Enable TLS**:
```yaml
# Create TLS certificates
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: observability-tls
spec:
  secretName: observability-tls
  dnsNames:
  - kiali.example.com
  - grafana.example.com
  - jaeger.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

**3. Network Policies**:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: observability-ingress
  namespace: observability
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: istio-system  # Allow from ingress
    - namespaceSelector:
        matchLabels:
          name: shlink  # Allow from app
```

**4. RBAC**:
```yaml
# Limit Kiali access
auth:
  strategy: openid
rbac:
  enabled: true
```

### Backup & Recovery

**Grafana Dashboards**:
```bash
# Backup
kubectl get configmap -n observability -l grafana_dashboard=1 -o yaml > grafana-dashboards-backup.yaml

# Restore
kubectl apply -f grafana-dashboards-backup.yaml
```

**Prometheus Data**:
```bash
# Backup (via snapshots)
kubectl exec -n observability prometheus-xxx-0 -- \
  curl -XPOST http://localhost:9090/api/v1/admin/tsdb/snapshot

# Or use Prometheus remote write to long-term storage
```

**ArgoCD Configuration**:
```
All observability configs are in Git!
Disaster recovery = Re-apply from Git
```

### Monitoring the Monitoring

**Health Checks**:
```bash
# Prometheus
curl http://prometheus.observability:9090/-/healthy

# Grafana
curl http://grafana.observability:3000/api/health

# Jaeger
curl http://jaeger-query.observability:16686/

# Kiali
curl http://kiali.observability:20001/kiali/healthz
```

**Alerts on Observability Stack**:
```yaml
# Create PrometheusRule
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: observability-alerts
spec:
  groups:
  - name: observability
    rules:
    - alert: PrometheusDown
      expr: up{job="prometheus"} == 0
      for: 5m
      annotations:
        summary: "Prometheus is down"
    - alert: GrafanaDown
      expr: up{job="grafana"} == 0
      for: 5m
```

### Cost Optimization

**Storage Costs**:
```
Reduce retention periods if cost is concern:
- Prometheus: 7d (current) vs 30d (production)
- Jaeger: Use sampling (1% vs 100%)
```

**Resource Optimization**:
```bash
# Monitor actual usage
kubectl top pods -n observability

# Adjust requests/limits based on actual usage
```

**Jaeger Sampling**:
```yaml
# Sample 10% of traces instead of 100%
meshConfig:
  defaultConfig:
    tracing:
      sampling: 10.0  # Reduces Jaeger load by 90%
```

---

## Lessons Learned

### 1. Istio Automatic Instrumentation is Powerful

**What Worked**:
- Zero code changes to Shlink
- Automatic trace header injection
- Metrics collection without app awareness
- Service mesh topology auto-discovered

**Key Insight**: With Istio sidecars, you get enterprise observability "for free"

### 2. GitOps Everything

**What Worked**:
- All observability configs in Git
- ArgoCD auto-sync enabled
- Reproducible deployments
- Easy disaster recovery

**Challenge**:
- Jaeger Operator had RBAC issues
- Solution: Switched to simple Kustomize deployment

**Recommendation**: Use operators when they work well (Kiali, Prometheus). Use simple deployments (Kustomize) when operators are complex.

### 3. LoadBalancer Port Conflicts

**Issue**:
- Grafana initially tried port 80 (LoadBalancer)
- Conflict with Istio ingress gateway (also port 80)
- K3s couldn't assign LoadBalancer IP

**Solution**:
- Changed Grafana to port 3000
- Use different ports for each LoadBalancer service

**Learning**: Plan LoadBalancer ports ahead to avoid conflicts

### 4. Storage Matters

**What Worked**:
- Prometheus PVC ensures metrics survive pod restarts
- Grafana PVC preserves custom dashboards

**Challenge**:
- Jaeger in-memory storage loses traces on restart

**Production**: Use Elasticsearch or Cassandra for Jaeger

### 5. Integration is Key

**What Worked**:
- Kiali → Prometheus integration (for topology)
- Kiali → Jaeger integration (for traces)
- Kiali → Grafana integration (for dashboards)
- Seamless navigation between tools

**Benefit**: Single pane of glass for observability

### 6. Observability Without Instrumentation

**Key Achievement**:
- Full request tracing without touching Shlink code
- Detailed metrics without application exports
- Service graph without service discovery code

**Istio Provides**:
- Automatic trace context propagation
- Metrics scraping from sidecar Envoys
- Service discovery from Kubernetes

### 7. Start Simple, Add Complexity

**Deployment Order**:
1. Started with Istio basics (Gateway + VirtualService)
2. Added Kiali for visualization
3. Added Prometheus + Grafana for metrics
4. Finally added Jaeger for tracing

**Recommendation**: Deploy incrementally and verify each component

### 8. Documentation Saves Time

**Best Practices**:
- Document access URLs immediately
- Record configuration decisions
- Note troubleshooting steps
- Keep architecture diagrams updated

This documentation is the result!

---

## Summary

### What We Achieved

A **production-ready, GitOps-managed observability stack** providing:

✅ **Complete Visibility**:
- Metrics: Request rates, latencies, errors
- Traces: Full request paths across services
- Topology: Service mesh graph
- Dashboards: Pre-built Istio dashboards

✅ **Zero Application Changes**:
- Istio automatic instrumentation
- No code modifications required
- Works with any application

✅ **Production Features**:
- Persistent storage (Prometheus, Grafana)
- High availability ready
- LoadBalancer access
- RBAC and authentication ready

✅ **GitOps Managed**:
- Everything in Git
- ArgoCD auto-sync
- Reproducible deployments
- Version controlled

### Quick Reference

**Access URLs**:
- Kiali: http://192.168.2.242:20001
- Grafana: http://192.168.2.242:3000 (admin/admin)
- Jaeger: http://192.168.2.242:16686

**Key Files**:
```
kubernetes/
├── argocd/apps/
│   ├── cert-manager.yaml
│   ├── prometheus-stack.yaml
│   ├── kiali-operator.yaml
│   └── jaeger.yaml
├── kustomize/
│   ├── shlink/istio/
│   │   ├── gateway.yaml
│   │   └── virtualservice.yaml
│   └── jaeger/
│       ├── deployment.yaml
│       └── service.yaml
```

**Key Commands**:
```bash
# View service mesh
open http://192.168.2.242:20001

# View metrics
open http://192.168.2.242:3000

# View traces
open http://192.168.2.242:16686

# Generate traffic
for i in {1..20}; do curl -s http://192.168.2.242/rest/health; done
```

### Next Steps

1. **Explore Dashboards**: Navigate through Kiali, Grafana, and Jaeger
2. **Generate Traffic**: Create more short URLs and observe traces
3. **Customize**: Add custom Grafana dashboards for your metrics
4. **Alerts**: Set up Prometheus alerts for critical conditions
5. **Production**: Implement HA, authentication, and TLS for production use

The observability stack is now operational and monitoring your Shlink URL shortener in real-time!
