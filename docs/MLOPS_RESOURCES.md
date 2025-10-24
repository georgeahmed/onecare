# MLOps Resource Profiles & Scheduling

Model services require predictable node placement and resource governance to avoid noisy neighbours and GPU starvation. Use this guide to configure resource classes and document expectations.

## Node Scheduling

- GPU workloads must target labelled nodes. Example deployment: `infra/k8s/mlops/resources/safety-gate-gpu-deployment.yaml`.
  - `nodeSelector.accelerator: nvidia-t4`
  - Tolerate `nvidia.com/gpu` taints for dedicated pools.
  - Request and limit `nvidia.com/gpu: 1` to enforce exclusivity.
- CPU-only workloads should target general pools (`nodeSelector: { workload.onecare.io/tier: general }`) and avoid GPU nodes unless necessary.
- Enable topology-awareness when available (e.g., `topologySpreadConstraints`) to keep replicas in separate failure domains.

## Resource Classes

| Profile | Use Case | Requests / Limits | Notes |
| --- | --- | --- | --- |
| `cpu-light` | Shadow, preprocessing | 250m / 500m CPU, 512 Mi / 1 Gi memory | No GPU |
| `gpu-light` | Real-time triage (T4) | 2 CPU / 4 CPU, 4 Gi / 6 Gi memory, 1 GPU | Configured in example manifest |
| `gpu-heavy` | Batch scoring (A10) | 4 CPU / 8 CPU, 8 Gi / 12 Gi memory, 1 GPU | Increase `CUDA_VISIBLE_DEVICES` if multi-GPU |

Document the chosen profile in the service README and use labels (`workload.onecare.io/profile`) for inventory tracking.

## Environment Controls

- Enforce explicit CUDA limits (`CUDA_VISIBLE_DEVICES=0`).
- Cap temporary storage with `emptyDir.medium=Memory` for scratch space; avoid writing PHI to disk.
- Set `OOMScoreAdj` to bias critical services lower than background tasks.

## Verification

- `kubectl get pods -o=custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,GPU:.spec.containers[*].resources.requests.nvidia\.com/gpu`
- Check GPU utilisation through DCGM or `nvidia-smi` DaemonSet; alert when >85% for 5 minutes.
- Validate that pods fall back to CPU gracefully—document failover or rules engine fallback in the service runbook.
