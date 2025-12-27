# Architecture Decision Records (ADR)

**Project:** URL Shortener - SRE Learning Lab
**Author:** Manu B Sreekumari
**Last Updated:** December 26, 2024
**Status:** Accepted - Ready for Implementation

## Overview

This document captures the architectural decisions made for the URL shortener homelab project. Each decision follows a structured framework: Decision → Context → Alternatives → Rationale → Trade-offs. These decisions prioritize learning production SRE patterns while working within homelab resource constraints.

The system will be built incrementally:
1. **Phase 1 (Homelab):** K3s cluster on Proxmox with Istio, Redis, PostgreSQL
2. **Phase 2 (Cloud Migration):** Deploy to AWS EKS to demonstrate cloud-native patterns
3. **Phase 3 (Optimization):** Load testing, chaos engineering, performance tuning

## Table of Contents

1. [Database Selection: PostgreSQL](#database-selection-postgresql)
2. [Cache Selection: Redis](#cache-selection-redis)
3. [Traffic Management & Service Mesh: Istio](#traffic-management--service-mesh-istio)
4. [Kubernetes Distribution: K3s](#kubernetes-distribution-k3s)
5. [Cross-Decision Dependencies](#cross-decision-dependencies)

---

## Database Selection: PostgreSQL

**Decision Date:** December 26, 2024
**Status:** Accepted
**Decision Owner:** Manu

### Decision

PostgreSQL as the primary datastore for URL mappings and analytics data.

### Context

- URL shortener is a read-heavy system (estimated 100:1 read:write ratio)
- Requires durable storage for URL mappings (short_code → long_url)
- Analytics data needs relational queries (top domains, click patterns over time)
- Expected scale: millions of URLs, thousands of requests/second

### Alternatives Considered

1. **NoSQL (DynamoDB/MongoDB)**: Pure key-value lookups, simpler for single-table access
2. **MySQL**: Similar capabilities to Postgres, more mature ecosystem
3. **In-memory only (Redis)**: Fastest reads, but lacks durability

### Why PostgreSQL

- **ACID guarantees** ensure URL mappings are never lost or corrupted during concurrent writes
- **Relational model** supports analytics queries (JOIN operations, time-series aggregations) without moving data to separate analytics store
- **Mature indexing** (B-tree for primary lookups, GiST for geospatial analytics if needed)
- **Industry-proven** at scale - battle-tested in production environments handling similar workloads
- **Good enough performance** with proper indexing - since 99% of reads hit cache, DB only serves cache misses

### Trade-offs Accepted

- **Slightly higher write latency** vs NoSQL (~5-10ms vs ~2ms) - acceptable since writes are <1% of traffic
- **More operational complexity** than managed NoSQL - but aligns with homelab learning goals for database management
- **Vertical scaling limits** (~10K writes/sec single instance) - sufficient for MVP, can add read replicas later

### Performance Characteristics

*(Will measure after implementation - baseline expectations below)*

- **Write latency**: ~5-10ms P99
- **Read latency**: ~15-20ms P99 on cache miss
- **Target cache hit ratio**: >95%, making DB performance less critical for redirect path

### Dependencies

- **Depends on:** None (foundational component)
- **Depended by:** Redis (uses Postgres as source of truth), Application pods (write/read URL mappings)

---

## Cache Selection: Redis

**Decision Date:** December 26, 2024
**Status:** Accepted
**Decision Owner:** Manu

### Decision

Redis cluster as the primary caching layer for URL lookups.

### Context

- URL shortener is read-heavy system (estimated 100:1 read:write ratio)
- Redirect latency is the critical user-facing metric - target <10ms P99
- Hot URLs (popular links) will account for majority of traffic (power law distribution)
- Expected scale: millions of URLs cached, thousands of requests/second
- Cache misses fall back to Postgres (~15-20ms penalty)

### Alternatives Considered

1. **Memcached**: Simpler key-value store, lower memory overhead, multi-threaded
2. **In-application cache**: Fastest (no network hop), but lost on pod restart
3. **CDN caching**: Lowest possible latency, but complex invalidation and not suitable for dynamic short codes

### Why Redis

- **Sub-millisecond latency**: 200-500μs read latency enables <5ms total redirect time
- **Data structures**: Supports strings (for URL mappings), sorted sets (for analytics like "top 10 URLs"), hashes (for metadata)
- **Persistence options**: Can enable AOF (Append-Only File) or RDB snapshots for cache warm-up after restarts - reduces cold-start DB load
- **Cluster mode**: Horizontal scaling via sharding when single-node limits reached (~50K ops/sec sustainable)
- **High availability**: Redis Sentinel or Cluster provides automatic failover - cache stays available during node failures
- **Production-proven**: Battle-tested at massive scale (Twitter, GitHub, Stack Overflow use Redis for similar use cases)

### Why Not Alternatives

- **Memcached**: Lacks data persistence and replication - full cache rebuild on restart would slam Postgres
- **In-app cache**: Each pod has separate cache (wasted memory), cache misses increase with more pods
- **CDN**: Can't handle POST requests for URL creation, harder to implement rate limiting

### Trade-offs Accepted

- **Memory cost**: Redis stores entire dataset in RAM - at 1M URLs × 200 bytes avg = ~200MB, acceptable for homelab
- **Operational complexity**: Need to monitor memory usage, eviction policies, replication lag vs simpler Memcached
- **Single point of failure (MVP)**: Running single Redis instance initially - acceptable for learning project, would add Sentinel for production
- **Cache invalidation**: Manual invalidation needed if URLs are updated/deleted (rare in URL shortener use case)
- **Network hop overhead**: Adds 1-2ms vs in-memory cache, but shared state across pods is worth it

### Performance Characteristics

*(Will measure after implementation - baseline expectations below)*

- **Write latency**: ~300-500μs P99 (SET operation)
- **Read latency**: ~200-400μs P99 (GET operation)
- **Throughput**: 50K+ ops/sec on single instance (homelab UM790 Pro easily handles this)
- **Target cache hit ratio**: >95% (industry standard for URL shorteners)
- **Cache miss penalty**: +15-20ms to fetch from Postgres
- **Memory efficiency**: ~200 bytes per cached URL (short_code + long_url + metadata)

### Cache Strategy Details

- **TTL**: 1 hour default (balances freshness vs DB load)
- **Eviction policy**: `allkeys-lru` (evict least recently used when memory full)
- **Key pattern**: `url:{short_code}` for easy identification and cleanup
- **Warming strategy**: Pre-populate top 1000 URLs on startup from Postgres analytics

### Dependencies

- **Depends on:** PostgreSQL (source of truth for cache misses)
- **Depended by:** Application pods (primary data access layer)

---

## Traffic Management & Service Mesh: Istio

**Decision Date:** December 26, 2024
**Status:** Accepted
**Decision Owner:** Manu

### Decision

Istio service mesh for ingress, traffic management, and inter-service communication.

### Context

- URL shortener needs intelligent traffic routing (rate limiting at edge, potential A/B testing of redirect behavior)
- Homelab environment requires production-like patterns without cloud-native managed services
- Security requirements: mTLS between components, defense against abuse (rate limiting, DDoS protection)
- Observability is critical: need visibility into request flow, latency breakdown, error rates across service boundaries
- Future expansion planned: may add analytics service, admin API, custom domain routing

### Alternatives Considered

1. **Kubernetes Ingress (nginx/traefik)**: Simpler L7 routing, less operational overhead, no service mesh features
2. **Envoy standalone**: Just the data plane without Istio control plane, lower resource usage
3. **API Gateway (Kong/Ambassador)**: Feature-rich but focused on north-south traffic, less observability depth
4. **No mesh (direct Service exposure)**: Simplest option, relies on application-level implementation

### Why Istio

**Traffic Management:**
- **Rate limiting at ingress**: Protect backend from abuse without application code changes (Envoy local rate limit filter)
- **Advanced routing**: Can implement percentage-based traffic splits for testing cache strategies or URL generation algorithms
- **Retries and timeouts**: Automatic retry logic for transient failures (Redis unavailable, Postgres connection pool exhausted)
- **Circuit breaking**: Prevent cascade failures if backend services degrade

**Security:**
- **Automatic mTLS**: All pod-to-pod traffic encrypted without code changes (Shlink → Postgres, Shlink → Redis)
- **Zero-trust networking**: AuthorizationPolicy lets us enforce "only Shlink pods can access Redis" at mesh level
- **External threat protection**: Can implement request validation, header sanitization at ingress

**Observability (most relevant for SRE):**
- **Automatic metrics**: Four golden signals (latency, traffic, errors, saturation) for every service without instrumentation
- **Distributed tracing**: Request flows across Istio → Pod → Redis → Postgres visible in Jaeger
- **Service topology**: Kiali shows real-time traffic flow, helps debug "why is Redis seeing traffic when cache should be hitting?"
- **Access logs**: Envoy captures every request for audit/debugging

**Production Learning:**
- **Interview credibility**: Demonstrates understanding of service mesh patterns used at scale (Lyft, Airbnb, eBay)
- **Career-relevant**: Istio/Envoy skills directly applicable to cloud-native SRE roles

### Why Not Alternatives

- **Nginx Ingress**: No mTLS, limited observability (just ingress layer), would need separate solutions for tracing/metrics
- **Envoy standalone**: Manual configuration management, no centralized control plane for fleet-wide policy updates
- **API Gateway**: Overkill for internal communication, doesn't solve east-west traffic observability
- **No mesh**: Puts burden on application code for retries, timeouts, mTLS - violates separation of concerns

### Trade-offs Accepted

- **Operational complexity**: Added component to monitor/upgrade (Istiod, sidecar injector, CRDs like VirtualService, DestinationRule)
- **Latency overhead**: ~3-5ms P50 added latency per hop due to sidecar proxy (acceptable for learning environment, <10ms redirect target still achievable)
- **Resource consumption**: Each pod gets Envoy sidecar (~50MB memory, 0.1 vCPU baseline) - meaningful in homelab with limited resources
- **Debugging difficulty**: Request failures could be app-level OR mesh-level (need to check both Shlink logs and Envoy logs)
- **Learning curve**: Understanding VirtualService, DestinationRule, AuthorizationPolicy concepts takes time

### Performance Characteristics

*(Will measure after implementation - baseline expectations below)*

**Data Plane (Envoy sidecar):**
- **Latency overhead**: 3-5ms P50, 8-12ms P99 at 1000 RPS (based on Istio benchmarks)
- **Throughput**: 50K+ RPS per sidecar before becoming bottleneck
- **Memory**: ~50-70MB per sidecar baseline
- **CPU**: ~0.2 vCPU per 1000 RPS

**Control Plane (Istiod):**
- **Config propagation**: 1-3 seconds for new routing rules to reach all proxies
- **Resource usage**: ~200MB memory, 0.1 vCPU (scales with number of services, not traffic)

**mTLS Impact:**
- **CPU overhead**: ~20-25% additional CPU for encryption/decryption (TLS handshake + data plane)
- **Latency**: Negligible (<1ms) after handshake completes

**For URL shortener specifically:**
- Total redirect path: Client → Istio Ingress (3-5ms) → Shlink Pod → Redis (cache hit)
- Target: <10ms P99 end-to-end including Istio overhead
- Acceptable because observability/security benefits outweigh latency cost for this use case

### Implementation Notes

- **Start simple**: Deploy with sidecar injection, basic VirtualService for ingress
- **Add complexity incrementally**: Enable mTLS → Add rate limiting → Implement tracing → Layer in circuit breakers
- **Monitoring priorities**: Watch sidecar CPU/memory consumption on UM790 Pro, ensure homelab can sustain overhead

### Dependencies

- **Depends on:** K3s cluster (runs as Kubernetes workload)
- **Depended by:** All application components (provides ingress, mTLS, observability)

---

## Kubernetes Distribution: K3s

**Decision Date:** December 26, 2024
**Status:** Accepted
**Decision Owner:** Manu

### Decision

K3s lightweight Kubernetes distribution for homelab cluster deployment.

### Context

- **Homelab environment**: Running on Minisforum UM790 Pro with Proxmox (64GB RAM shared across multiple VMs)
- **Resource constraints**: Need to preserve resources for application workloads (Shlink, Redis, Postgres, observability stack)
- **Learning goals**: Focus on application architecture, service mesh patterns, and SRE practices - not Kubernetes installation complexity
- **Cloud migration planned**: Will deploy to AWS EKS after homelab validation, demonstrating understanding of both self-managed and managed k8s

### Alternatives Considered

1. **Standard Kubernetes (kubeadm)**: Full-featured distribution with all components
2. **Minikube/kind**: Single-node local development clusters
3. **MicroK8s**: Canonical's lightweight distribution
4. **Managed Kubernetes**: Skip self-hosting entirely, use cloud from start

### Why K3s

**Resource Efficiency:**
- **Control plane footprint**: ~512MB RAM vs 2-3GB for standard k8s - critical in homelab with shared resources
- **Worker node overhead**: ~256MB RAM vs 1GB+ for standard k8s agents
- **Binary size**: Single 70MB binary vs multi-component installation requiring hundreds of MB
- **CPU baseline**: ~0.5 vCPU for control plane vs 1-2 vCPU for standard k8s components
- **Allows 3-node cluster** on single physical host without starving application workloads

**Operational Simplicity:**
- **Installation**: Single command (`curl -sfL https://get.k3s.io | sh -`) vs multi-step kubeadm setup
- **Time to cluster**: 5 minutes vs hours for kubeadm with HA etcd
- **Built-in components**: Includes Traefik ingress (we'll replace with Istio), CoreDNS, local-path storage provisioner
- **Automatic TLS**: Generates and manages certificates for API server and kubelets
- **Simplified upgrades**: Binary replacement vs coordinated multi-component upgrades

**Homelab-Optimized Features:**
- **SQLite default**: No need to manage separate etcd cluster for learning environment
- **Embedded containerd**: No separate container runtime installation/management
- **Low-touch operation**: Runs as systemd service, automatic restart on failure
- **Air-gap capable**: Can operate fully offline after initial setup (useful for network experiments)

**Production Learning Value:**
- **CNCF certified**: Fully compliant k8s - same API, same kubectl, same workloads
- **Real-world usage**: Powers Tesla vehicles, edge IoT deployments, Rancher's own infrastructure
- **Interview credibility**: Demonstrates understanding of k8s variants and architectural trade-offs
- **Transferable skills**: Everything learned applies to standard k8s (pods, services, deployments, etc.)

### Why Not Alternatives

**Standard Kubernetes:**
- Resource overhead would consume 30-40% of homelab capacity just for control plane
- Installation complexity delays project start (multi-day setup vs 5 minutes)
- Features we don't need: Cloud provider integrations, legacy admission controllers, alpha features

**Minikube/kind:**
- Single-node clusters don't demonstrate multi-node patterns (pod affinity, node failure scenarios)
- Not production-representative for interview discussions
- Can't practice HA concepts, load balancing across nodes

**MicroK8s:**
- Snap-based installation (adds dependency, less portable)
- Less adoption in edge/production scenarios vs K3s
- Similar resource profile to K3s but less familiar to industry

**Managed Kubernetes (EKS/GKE):**
- Cost (~$70/month for basic cluster) vs free homelab
- Can't experiment with control plane failures, resource constraints
- Skips understanding of k8s internals valuable for SRE roles

### Trade-offs Accepted

**Limited Enterprise Features:**
- **No cloud integrations**: Can't use AWS ELB, GCP load balancers - not needed for homelab, will use EKS for cloud deployment
- **Basic load balancer**: klipper-lb (ServiceLB) is simple vs MetalLB - sufficient for learning, demonstrates understanding of limitations
- **Simpler storage**: local-path provisioner vs sophisticated CSI drivers - acceptable for stateless apps and learning scenarios

**Scalability Constraints:**
- **SQLite limitations**: Default datastore doesn't support HA control plane - can migrate to etcd/MySQL/Postgres if needed, but single control plane acceptable for homelab
- **Recommended limit**: ~10 nodes with SQLite backend - far exceeds homelab needs
- **Not testing at scale**: Won't experience large cluster operational challenges - but interviews focus on concepts, not managing 1000-node clusters

**Learning Gaps:**
- **Abstraction hides complexity**: Won't learn etcd operations, kubeadm bootstrap process - acceptable tradeoff for time constraints
- **Different upgrade path**: k3s-specific process vs kubeadm - but demonstrates understanding of upgrade strategies generally
- **Tooling assumptions**: Some troubleshooting guides assume standard k8s component layout - requires adapting documentation

**Operational Differences:**
- **Debugging variations**: Component names/paths differ from standard k8s (e.g., k3s-server vs kube-apiserver)
- **Community resources**: Smaller than vanilla k8s, though still substantial and growing
- **Enterprise acceptance**: Some organizations have policies requiring "standard" k8s - aware of limitation, can justify choice

### Performance Characteristics

*(Will measure after deployment - baseline expectations below)*

**Resource Utilization:**
- **Control plane node**: ~512MB RAM, 0.5 vCPU baseline
- **Worker nodes**: ~256MB RAM, 0.2 vCPU baseline per agent
- **3-node cluster**: ~1.5GB total overhead vs 6-9GB for standard k8s cluster
- **Leaves ~60GB RAM** for application workloads on UM790 Pro

**API Performance:**
- **SQLite latency**: Slightly higher than etcd for large clusters (negligible at <10 nodes)
- **API response**: <100ms for typical operations (get/list pods, services)
- **Pod startup**: Similar to standard k8s (~5-10 seconds for simple pods)

**Cluster Stability:**
- **Startup time**: ~30 seconds to full operational state
- **Restart recovery**: Automatic via systemd, <60 seconds to restore API availability
- **Network performance**: Identical to standard k8s (same CNI options - Flannel default)

### Implementation Strategy

**Phase 1 - MVP (Current):**
- Single-server K3s with embedded SQLite
- Local-path storage for Postgres/Redis persistent volumes
- Built-in Traefik replaced with Istio for service mesh learning

**Phase 2 - HA Exploration (Optional):**
- Add external MySQL/Postgres datastore for control plane HA
- Deploy second server node for control plane redundancy
- Practice control plane failure scenarios

**Phase 3 - Cloud Migration:**
- Document differences between K3s homelab and AWS EKS
- Demonstrate understanding of managed vs self-hosted trade-offs
- Use for interview discussion: "Started with K3s for efficiency, migrated to EKS for production patterns"

### Interview Talking Points

**Why this choice demonstrates SRE thinking:**
- "Optimized for constraints" - chose right tool for environment (resource-limited homelab)
- "Pragmatic over purist" - focused on application learning goals vs infrastructure complexity
- "Production awareness" - understand when K3s is appropriate vs when standard k8s/managed services needed
- "Cost-conscious" - free homelab vs $70/month EKS, demonstrating fiscal responsibility
- "Time-boxed" - made architectural choice that enables faster iteration given January interview deadline

**Addressing potential concerns:**
- "Is K3s production-ready?" - Yes, CNCF certified, used by Tesla, SUSE enterprise support available
- "Why not use EKS from start?" - Wanted to understand k8s internals before using managed abstraction
- "Aren't you missing learning opportunities?" - Focus was service mesh, caching, observability - not k8s installation
- "How does this translate to enterprise?" - Concepts identical, just different control plane management - will demonstrate with EKS migration

### Dependencies

- **Depends on:** Proxmox virtualization layer (provides VMs for cluster nodes)
- **Depended by:** All other components (foundational infrastructure)

---

## Cross-Decision Dependencies

This section maps how the architectural decisions interact and depend on each other:

```
Proxmox (Physical Infrastructure)
    ↓
K3s Cluster (Orchestration Foundation)
    ↓
    ├─→ Istio (Traffic Management & Observability)
    │       ↓
    │   Application Pods (Shlink)
    │       ↓
    │       ├─→ Redis (Cache Layer)
    │       │       ↓ (cache miss)
    │       └─→ PostgreSQL (Source of Truth)
    │
    └─→ Observability Stack (Prometheus, Grafana, Jaeger)
            ↓
        (scrapes metrics from Istio + Apps)
```

**Key Dependency Notes:**

1. **Redis depends on PostgreSQL**: Cache-aside pattern means Redis serves as fast lookup layer, but Postgres is the authoritative source
2. **Istio provides observability for all components**: Service mesh automatically instruments Redis, Postgres, application traffic
3. **K3s enables everything**: Lightweight footprint allows running the full stack on homelab hardware
4. **Application sits between layers**: Shlink app orchestrates Redis (cache) → Postgres (DB) logic

**Failure Mode Analysis:**

- **Postgres down**: Redis continues serving cached URLs (degraded but functional), new URL creation fails
- **Redis down**: All requests fall back to Postgres (slower but functional), no data loss
- **Istio issues**: Applications still function, but lose traffic management, mTLS, observability
- **K3s control plane down**: Existing pods continue running, but can't deploy/scale new workloads

---

## Next Steps

1. **Implementation Phase**: Build system according to these decisions
2. **Measurement Phase**: Collect real performance data to validate/update "Performance Characteristics" sections
3. **Lessons Learned**: Document what worked, what didn't, what would be done differently
4. **AWS Migration**: Deploy to EKS and document cloud-native patterns vs homelab patterns

**Document Updates:**
- This ADR is a living document
- Update "Performance Characteristics" sections with real measurements after implementation
- Add "Lessons Learned" subsection to each decision after running in production
- Mark decisions as "Superseded" if changed, link to new ADR

---

**Document Version History:**

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2024-12-26 | Initial architecture decisions | Manu B Sreekumari|
