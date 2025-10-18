#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/ci/deploy.sh <environment> [strategy]" >&2
  exit 1
fi

ENVIRONMENT="$1"
STRATEGY="${2:-standard}"
RELEASE_DIR="infra/k8s/releases/${ENVIRONMENT}"
KUBE_CONFIG_DATA="${KUBE_CONFIG_DATA:-}"
NAMESPACE="${DEPLOY_NAMESPACE:-onecare-${ENVIRONMENT}}"

if [[ -z "${KUBE_CONFIG_DATA}" ]]; then
  echo "::error title=Missing kubeconfig::KUBE_CONFIG_DATA environment variable is not set; cannot deploy to ${ENVIRONMENT}." >&2
  exit 1
fi

if [[ ! -d "${RELEASE_DIR}" ]]; then
  echo "::warning title=No release manifests::${RELEASE_DIR} does not exist; nothing to apply for ${ENVIRONMENT}." >&2
  exit 0
fi

if ! compgen -G "${RELEASE_DIR}/*.yaml" >/dev/null && [[ ! -f "${RELEASE_DIR}/kustomization.yaml" ]]; then
  echo "::warning title=Empty release::${RELEASE_DIR} contains no YAML manifests or kustomization; skipping deployment." >&2
  exit 0
fi

mkdir -p ~/.kube
if [[ "${KUBE_CONFIG_DATA}" == *"apiVersion:"* ]]; then
  printf "%s" "${KUBE_CONFIG_DATA}" > ~/.kube/config
else
  printf "%s" "${KUBE_CONFIG_DATA}" | base64 --decode > ~/.kube/config
fi

kubectl version --client

kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1 || kubectl create namespace "${NAMESPACE}"

DEPLOY_CMD=()
if [[ -f "${RELEASE_DIR}/kustomization.yaml" ]]; then
  DEPLOY_CMD=(kubectl apply -k "${RELEASE_DIR}")
else
  DEPLOY_CMD=(kubectl apply -n "${NAMESPACE}" -f "${RELEASE_DIR}")
fi

echo "::group::Deploy ${ENVIRONMENT} (${STRATEGY})"
"${DEPLOY_CMD[@]}"
echo "::endgroup::"

if [[ "${STRATEGY}" == "canary" ]]; then
  kubectl describe deployments -n "${NAMESPACE}" || true
fi

if kubectl get deployments -n "${NAMESPACE}" --no-headers >/dev/null 2>&1; then
  DEPLOY_COUNT=$(kubectl get deployments -n "${NAMESPACE}" --no-headers | wc -l | tr -d ' ')
  if [[ "${DEPLOY_COUNT}" != "0" ]]; then
    kubectl rollout status deployment --all -n "${NAMESPACE}" --timeout=5m
  else
    echo "No deployments found in namespace ${NAMESPACE}; skipping rollout status check."
  fi
else
  echo "No deployments found in namespace ${NAMESPACE}; skipping rollout status check."
fi

kubectl get pods -n "${NAMESPACE}" || true
