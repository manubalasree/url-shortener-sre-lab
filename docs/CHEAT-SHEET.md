# URL Shortener SRE Lab - Quick Reference Cheat Sheet

**Purpose**: Fast command reference for common operations, troubleshooting, and monitoring

**Last Updated**: December 30, 2024

---

## Environment Setup

```bash
# Set kubeconfig
export KUBECONFIG=~/.kube/config-k3s

# Verify cluster access
kubectl cluster-info
kubectl get nodes
```

---

## Quick Health Checks

### Overall System Status
```bash
# Check all ArgoCD applications
kubectl get applications -n argocd

# Check pods in all namespaces
kubectl get pods -A

# Check only critical namespaces
kubectl get pods -n shlink
kubectl get pods -n postgres
kubectl get pods -n redis
kubectl get pods -n istio-system
kubectl get pods -n observability
```

### Application Health
```bash
# Shlink health endpoint (from outside cluster)
curl -s http://192.168.2.242/rest/health | jq

# Shlink health endpoint (from inside pod)
kubectl exec -n shlink deployment/shlink -- \
  curl -s http://localhost:8080/rest/health | jq

# Expected output:
# {
#   "status": "pass",
#   "version": "4.x.x"
# }
```

### Service Status
```bash
# Check all services
kubectl get svc -A

# Check LoadBalancer services
kubectl get svc -A | grep LoadBalancer

# Expected LoadBalancers:
# istio-system     istio-ingressgateway   LoadBalancer   192.168.2.242
# observability    prometheus-stack-grafana   LoadBalancer   192.168.2.242
# observability    kiali                  LoadBalancer   192.168.2.242
# observability    jaeger-query           LoadBalancer   192.168.2.242
```

---

## Access URLs & Credentials

### Service URLs
```bash
# Shlink (via Istio)
http://192.168.2.242

# ArgoCD
http://192.168.2.242:30080

# Grafana
http://192.168.2.242:3000
# Credentials: admin / admin

# Kiali
http://192.168.2.242:20001
# No auth

# Jaeger
http://192.168.2.242:16686
# No auth
```

### Get Secrets
```bash
# ArgoCD admin password
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d && echo

# Shlink API key
kubectl get secret -n shlink shlink-api-key \
  -o jsonpath='{.data.api-key}' | base64 -d && echo

# PostgreSQL password
kubectl get secret -n postgres shlink-db-pguser-shlink \
  -o jsonpath='{.data.password}' | base64 -d && echo
```

---

## Logs & Debugging

### View Logs
```bash
# Tail logs for a deployment
kubectl logs -n shlink deployment/shlink -f

# Tail logs for a specific pod
kubectl logs -n shlink <pod-name> -f

# Previous pod logs (after crash)
kubectl logs -n shlink <pod-name> --previous

# Logs from specific container in pod
kubectl logs -n shlink <pod-name> -c shlink -f

# Logs from Istio sidecar
kubectl logs -n shlink <pod-name> -c istio-proxy -f
```

### Describe Resources
```bash
# Describe pod (shows events, errors)
kubectl describe pod -n shlink <pod-name>

# Describe deployment
kubectl describe deployment -n shlink shlink

# Describe service
kubectl describe svc -n shlink shlink

# Describe ArgoCD application
kubectl describe application -n argocd shlink
```

### Execute Commands in Pods
```bash
# Interactive shell in Shlink pod
kubectl exec -it -n shlink deployment/shlink -- /bin/bash

# Run single command
kubectl exec -n shlink deployment/shlink -- env

# Test network connectivity
kubectl exec -n shlink deployment/shlink -- \
  curl -v http://shlink-db-primary.postgres.svc.cluster.local:5432

# Test DNS resolution
kubectl exec -n shlink deployment/shlink -- \
  nslookup shlink-db-primary.postgres.svc.cluster.local
```

---

## PostgreSQL Operations

### Connect to PostgreSQL
```bash
# Connect to primary database
kubectl exec -it -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -d shlink

# Connect as shlink user
kubectl exec -it -n postgres shlink-db-primary-0 -c database -- \
  psql -U shlink -d shlink

# Run single query
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -d shlink -c "SELECT version();"
```

### PostgreSQL Useful Queries
```sql
-- List databases
\l

-- List tables in shlink database
\dt

-- Show table schema
\d short_urls

-- Count rows
SELECT COUNT(*) FROM short_urls;

-- Check user permissions
SELECT * FROM information_schema.table_privileges WHERE grantee = 'shlink';

-- Grant schema permissions (if needed)
GRANT ALL ON SCHEMA public TO shlink;
GRANT ALL ON ALL TABLES IN SCHEMA public TO shlink;
```

### Check Replication Status
```bash
# Check replication on primary
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -c "SELECT * FROM pg_stat_replication;"

# Check replication on replica
kubectl exec -n postgres shlink-db-replica-0 -c database -- \
  psql -U postgres -c "SELECT pg_is_in_recovery();"
# Should return 't' (true)
```

---

## Redis Operations

### Connect to Redis
```bash
# Connect to Redis master
kubectl exec -it -n redis rfr-shlink-redis-0 -- redis-cli

# Connect to specific replica
kubectl exec -it -n redis rfr-shlink-redis-1 -- redis-cli

# Run single command
kubectl exec -n redis rfr-shlink-redis-0 -- redis-cli INFO replication
```

### Redis Useful Commands
```bash
# Check if master or replica
INFO replication | grep role

# Get all keys (WARNING: slow on large datasets)
KEYS *

# Check cluster mode (should be 0 for Sentinel)
INFO cluster | grep cluster_enabled

# Monitor commands in real-time
MONITOR

# Check memory usage
INFO memory

# Ping test
PING
```

### Check Sentinel Status
```bash
# Connect to Sentinel
kubectl exec -it -n redis rfs-shlink-redis-0 -- redis-cli -p 26379

# Sentinel commands
SENTINEL masters
SENTINEL replicas mymaster
SENTINEL sentinels mymaster
SENTINEL get-master-addr-by-name mymaster
```

---

## Istio Operations

### Check Istio Status
```bash
# Check Istio control plane
kubectl get pods -n istio-system

# Check sidecar injection status
kubectl get namespace shlink -o yaml | grep istio-injection

# List all Istio resources
kubectl get gateway,virtualservice,destinationrule,serviceentry -A
```

### Verify Sidecar Injection
```bash
# Check if pod has sidecar
kubectl get pod -n shlink <pod-name> -o jsonpath='{.spec.containers[*].name}'
# Should show: shlink istio-proxy

# View sidecar configuration
kubectl get pod -n shlink <pod-name> -o yaml | grep -A 10 istio-proxy
```

### Analyze Istio Traffic
```bash
# Get Envoy configuration from sidecar
kubectl exec -n shlink <pod-name> -c istio-proxy -- \
  pilot-agent request GET config_dump

# Get Envoy stats
kubectl exec -n shlink <pod-name> -c istio-proxy -- \
  curl -s http://localhost:15000/stats/prometheus
```

### Enable/Disable Sidecar Injection
```bash
# Enable injection for namespace
kubectl label namespace shlink istio-injection=enabled --overwrite

# Disable injection for namespace
kubectl label namespace shlink istio-injection-

# Restart pods to apply changes
kubectl rollout restart deployment -n shlink shlink
```

---

## ArgoCD Operations

### Application Management
```bash
# List all applications
kubectl get applications -n argocd

# Get application details
argocd app get shlink --grpc-web

# Sync application (force update from Git)
argocd app sync shlink --grpc-web

# Sync all applications
argocd app sync -l app.kubernetes.io/instance=root-app --grpc-web

# Refresh application (check Git for changes without syncing)
argocd app refresh shlink --grpc-web
```

### Login to ArgoCD
```bash
# Get admin password
ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d)

# Login via CLI
argocd login 192.168.2.242:30080 \
  --username admin \
  --password "$ARGOCD_PASSWORD" \
  --grpc-web \
  --insecure

# Or export password for use
echo $ARGOCD_PASSWORD
```

### Application Status
```bash
# Check sync status
kubectl get applications -n argocd -o wide

# Watch sync in real-time
kubectl get applications -n argocd -w

# Get sync history
argocd app history shlink --grpc-web

# Rollback to previous revision
argocd app rollback shlink <revision-id> --grpc-web
```

### Troubleshooting ArgoCD Sync Issues
```bash
# View application events
kubectl describe application -n argocd shlink

# View ArgoCD controller logs
kubectl logs -n argocd deployment/argocd-application-controller -f

# View repo server logs
kubectl logs -n argocd deployment/argocd-repo-server -f

# Force sync even with errors
argocd app sync shlink --force --grpc-web

# Prune resources
argocd app sync shlink --prune --grpc-web
```

---

## Monitoring & Observability

### Prometheus Queries
```bash
# Port-forward Prometheus
kubectl port-forward -n observability svc/kube-prometheus-stack-prometheus 9090:9090

# Open in browser: http://localhost:9090

# Useful queries:
# - Request rate: rate(istio_requests_total[1m])
# - Request duration p95: histogram_quantile(0.95, rate(istio_request_duration_milliseconds_bucket[1m]))
# - Error rate: rate(istio_requests_total{response_code=~"5.."}[1m])
# - Pod CPU: sum(rate(container_cpu_usage_seconds_total{namespace="shlink"}[1m])) by (pod)
# - Pod memory: sum(container_memory_usage_bytes{namespace="shlink"}) by (pod)
```

### Check Prometheus Targets
```bash
# Port-forward and check targets
kubectl port-forward -n observability svc/kube-prometheus-stack-prometheus 9090:9090

# Navigate to: http://localhost:9090/targets
# Should see:
# - serviceMonitor/istio-system/servicemonitor-istiod
# - serviceMonitor/istio-system/servicemonitor-ingressgateway
# - podMonitor/istio-system/podmonitor-envoy-stats
```

### Grafana Dashboards
```bash
# Access Grafana
http://192.168.2.242:3000
# Login: admin / admin

# Navigate to Istio dashboards:
# Dashboards → Browse → Istio
# - Istio Control Plane Dashboard
# - Istio Service Dashboard (select service: shlink.shlink)
# - Istio Mesh Dashboard
# - Istio Workload Dashboard
```

### Jaeger Tracing
```bash
# Access Jaeger UI
http://192.168.2.242:16686

# Search for traces:
# 1. Service: shlink.shlink
# 2. Operation: All
# 3. Lookback: Last hour
# 4. Click "Find Traces"

# View specific trace to see:
# - Request flow through components
# - Time spent in each component
# - Database queries
# - Cache operations
```

### Kiali Service Graph
```bash
# Access Kiali
http://192.168.2.242:20001

# View service graph:
# 1. Select namespace: shlink
# 2. Graph tab
# 3. Display: "Traffic Animation"
# 4. Show: "Response Time" or "Request Rate"
```

---

## Load Testing

### Setup Environment
```bash
# Navigate to load tests directory
cd load-tests

# Set environment variables
export BASE_URL="http://192.168.2.242"
export SHLINK_API_KEY="<your-api-key>"
export DEFAULT_DOMAIN="shlink.local"

# Verify environment
echo $BASE_URL
echo $SHLINK_API_KEY
```

### Run Load Tests
```bash
# Run with automated script (recommended)
chmod +x run-tests.sh
./run-tests.sh

# Or run individual scenarios
k6 run --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --env DEFAULT_DOMAIN=$DEFAULT_DOMAIN \
  scenario1-baseline.js

# Run with results export
k6 run --out json=results/scenario1-$(date +%Y%m%d-%H%M%S).json \
  --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --env DEFAULT_DOMAIN=$DEFAULT_DOMAIN \
  scenario1-baseline.js
```

### Generate Test Traffic
```bash
# Simple traffic generation (no k6)
# Create URL
curl -X POST http://192.168.2.242/rest/v3/short-urls \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $SHLINK_API_KEY" \
  -d '{
    "longUrl": "https://example.com/test",
    "domain": "shlink.local"
  }'

# Test redirect
curl -I http://192.168.2.242/<short-code>

# Continuous traffic loop
for i in {1..100}; do
  curl -s http://192.168.2.242/ > /dev/null
  sleep 0.1
done
```

---

## Scaling Operations

### Scale Deployments
```bash
# Scale Shlink replicas
kubectl scale deployment -n shlink shlink --replicas=5

# Verify scaling
kubectl get pods -n shlink -w

# Scale back down
kubectl scale deployment -n shlink shlink --replicas=3
```

### Rolling Updates
```bash
# Update image
kubectl set image deployment/shlink -n shlink \
  shlink=shlinkio/shlink:4.0.0

# Watch rollout
kubectl rollout status deployment/shlink -n shlink

# View rollout history
kubectl rollout history deployment/shlink -n shlink

# Rollback to previous version
kubectl rollout undo deployment/shlink -n shlink

# Rollback to specific revision
kubectl rollout undo deployment/shlink -n shlink --to-revision=2
```

### Restart Deployments
```bash
# Restart all pods in deployment
kubectl rollout restart deployment -n shlink shlink

# Delete specific pod (will be recreated)
kubectl delete pod -n shlink <pod-name>
```

---

## Node Operations

### Node Information
```bash
# List nodes
kubectl get nodes -o wide

# Describe node
kubectl describe node <node-name>

# Check node resource usage
kubectl top nodes

# Check pod distribution across nodes
kubectl get pods -A -o wide | grep shlink
```

### Drain Node (for maintenance)
```bash
# Drain node (evict all pods)
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data

# Mark node as unschedulable (without evicting pods)
kubectl cordon <node-name>

# Make node schedulable again
kubectl uncordon <node-name>
```

---

## Resource Management

### View Resource Usage
```bash
# Pod resource usage (requires metrics-server)
kubectl top pods -n shlink

# Node resource usage
kubectl top nodes

# Detailed pod resources
kubectl describe pod -n shlink <pod-name> | grep -A 5 "Limits\|Requests"
```

### PersistentVolumes
```bash
# List PVCs
kubectl get pvc -A

# Describe PVC
kubectl describe pvc -n postgres shlink-db-primary-0

# List PVs
kubectl get pv

# Check storage usage (requires exec into pod)
kubectl exec -n postgres shlink-db-primary-0 -c database -- df -h
```

---

## Networking & DNS

### DNS Testing
```bash
# Test DNS resolution from pod
kubectl run -it --rm debug --image=busybox --restart=Never -- \
  nslookup shlink-db-primary.postgres.svc.cluster.local

# Test DNS from specific namespace
kubectl run -it --rm debug --image=busybox --restart=Never -n shlink -- \
  nslookup shlink.shlink.svc.cluster.local

# Verify CoreDNS is running
kubectl get pods -n kube-system -l k8s-app=kube-dns
```

### Network Connectivity Testing
```bash
# Test connectivity to service
kubectl run -it --rm debug --image=nicolaka/netshoot --restart=Never -- \
  curl -v http://shlink.shlink.svc.cluster.local:8080/rest/health

# Test connectivity to external service
kubectl run -it --rm debug --image=nicolaka/netshoot --restart=Never -- \
  curl -v https://google.com

# Check pod IP and network
kubectl get pod -n shlink <pod-name> -o wide
```

### Service Endpoints
```bash
# View service endpoints
kubectl get endpoints -n shlink shlink

# Should show pod IPs:
# NAME      ENDPOINTS
# shlink    10.42.0.20:8080,10.42.1.15:8080,10.42.2.10:8080
```

---

## Cleanup Operations

### Delete Resources
```bash
# Delete specific pod
kubectl delete pod -n shlink <pod-name>

# Delete deployment (removes all pods)
kubectl delete deployment -n shlink shlink

# Delete namespace (removes all resources in it)
kubectl delete namespace shlink
```

### Reset ArgoCD Application
```bash
# Delete and recreate application
argocd app delete shlink --cascade --grpc-web
kubectl apply -f kubernetes/argocd/apps/application/shlink.yaml
```

---

## Backup & Restore

### Export Resources
```bash
# Export deployment YAML
kubectl get deployment -n shlink shlink -o yaml > shlink-deployment-backup.yaml

# Export all resources in namespace
kubectl get all -n shlink -o yaml > shlink-namespace-backup.yaml

# Export specific resource types
kubectl get deployment,service,configmap,secret -n shlink -o yaml > backup.yaml
```

### PostgreSQL Backup
```bash
# Manual backup
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  pg_dump -U postgres -d shlink > shlink-db-backup.sql

# Automated backups configured via pgBackRest (handled by operator)
# Check backup status
kubectl get postgrescluster -n postgres shlink-db -o yaml | grep -A 10 backup
```

---

## Troubleshooting Quick Reference

### Pod Not Starting
```bash
# Check pod status
kubectl get pod -n shlink <pod-name>

# View events
kubectl describe pod -n shlink <pod-name>

# Check logs
kubectl logs -n shlink <pod-name>

# Common issues:
# - ImagePullBackOff: Image doesn't exist or registry auth failed
# - CrashLoopBackOff: Container crashes immediately after start
# - Pending: No node has resources to schedule pod
```

### Service Not Accessible
```bash
# Verify service exists
kubectl get svc -n shlink shlink

# Check endpoints
kubectl get endpoints -n shlink shlink

# If no endpoints, check pod labels match service selector
kubectl get pod -n shlink --show-labels
kubectl get svc -n shlink shlink -o yaml | grep selector -A 2

# Test from another pod
kubectl run -it --rm debug --image=nicolaka/netshoot --restart=Never -- \
  curl http://shlink.shlink.svc.cluster.local:8080/rest/health
```

### ArgoCD Not Syncing
```bash
# Check application status
kubectl get application -n argocd shlink

# View sync errors
argocd app get shlink --grpc-web

# Force sync
argocd app sync shlink --force --grpc-web

# Check repo server can access Git
kubectl logs -n argocd deployment/argocd-repo-server
```

### Prometheus Not Scraping
```bash
# Check ServiceMonitors exist
kubectl get servicemonitor,podmonitor -n istio-system

# Verify labels match Prometheus selector
kubectl get servicemonitor -n istio-system -o yaml | grep "release:"

# Check Prometheus logs
kubectl logs -n observability statefulset/prometheus-kube-prometheus-stack-prometheus
```

---

## Performance Tips

### Optimize kubectl Commands
```bash
# Use aliases
alias k=kubectl
alias kgp='kubectl get pods'
alias kgs='kubectl get svc'
alias kgn='kubectl get nodes'
alias kd='kubectl describe'
alias kl='kubectl logs'

# Set default namespace
kubectl config set-context --current --namespace=shlink

# Quick pod shell
alias kexec='kubectl exec -it'
```

### Watch Resources
```bash
# Watch pods
kubectl get pods -n shlink -w

# Watch with custom columns
kubectl get pods -n shlink -o custom-columns=\
NAME:.metadata.name,\
STATUS:.status.phase,\
NODE:.spec.nodeName,\
IP:.status.podIP -w

# Watch events
kubectl get events -n shlink --sort-by='.lastTimestamp' -w
```

---

## Emergency Procedures

### Full System Restart
```bash
# 1. Restart all Shlink pods
kubectl rollout restart deployment -n shlink shlink

# 2. Restart PostgreSQL (CAREFUL - downtime)
kubectl delete pod -n postgres shlink-db-primary-0
# Wait for pod to come back up

# 3. Restart Redis
kubectl delete pod -n redis rfr-shlink-redis-0

# 4. Restart Istio ingress
kubectl rollout restart deployment -n istio-system istio-ingressgateway

# 5. Verify everything is up
kubectl get pods -A
```

### Database Connection Issues
```bash
# 1. Verify PostgreSQL is running
kubectl get pods -n postgres

# 2. Test connection from Shlink pod
kubectl exec -n shlink deployment/shlink -- \
  nc -zv shlink-db-primary.postgres.svc.cluster.local 5432

# 3. Check database credentials
kubectl get secret -n postgres shlink-db-pguser-shlink -o yaml

# 4. Verify schema permissions
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -d shlink -c "\dn+"

# 5. Grant permissions if needed
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -d shlink -c "GRANT ALL ON SCHEMA public TO shlink;"
```

---

## Useful One-Liners

```bash
# Get all pod IPs in namespace
kubectl get pods -n shlink -o wide | awk '{print $6}'

# Count pods by status
kubectl get pods -A --no-headers | awk '{print $4}' | sort | uniq -c

# Find pods using most CPU
kubectl top pods -A --sort-by=cpu

# Find pods using most memory
kubectl top pods -A --sort-by=memory

# List all images in use
kubectl get pods -A -o jsonpath="{.items[*].spec.containers[*].image}" | tr -s '[[:space:]]' '\n' | sort | uniq

# Get all LoadBalancer IPs
kubectl get svc -A -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.name}{"\t"}{.status.loadBalancer.ingress[0].ip}{"\n"}{end}'

# Watch ArgoCD sync status
watch -n 2 'kubectl get applications -n argocd'

# Stream all logs from namespace
kubectl logs -n shlink --all-containers=true -f --max-log-requests=10

# Get pod restart counts
kubectl get pods -A --no-headers | awk '{print $5, $1, $2}' | sort -rn
```

---

## Reference Links

### Documentation Files
- Architecture Deep Dive: `docs/05-configuration-deep-dive.md`
- Architecture Decisions: `docs/01-architecture-decisions.md`
- Implementation Roadmap: `docs/02-implementation-roadmap.md`
- Shlink Integration: `docs/03-shlink-integration-guide.md`
- Observability Stack: `docs/04-observability-stack.md`
- Session Summary: `docs/SESSION-SUMMARY.md`

### Load Testing
- Main Guide: `load-tests/README.md`
- Quick Start: `load-tests/QUICK-START.md`
- Monitoring: `load-tests/MONITORING-CHECKLIST.md`

### Official Documentation
- K3s: https://docs.k3s.io
- Istio: https://istio.io/latest/docs/
- ArgoCD: https://argo-cd.readthedocs.io
- Prometheus: https://prometheus.io/docs/
- Grafana: https://grafana.com/docs/
- Jaeger: https://www.jaegertracing.io/docs/

---

**Pro Tip**: Keep this cheat sheet open in a terminal window while working. Use `Ctrl+F` to quickly find commands you need.
