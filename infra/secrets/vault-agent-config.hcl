exit_after_auth = false
pid_file = "/tmp/vault-agent.pid"

auto_auth {
  method "kubernetes" {
    mount_path = "auth/kubernetes"

    config = {
      role = "onecare-service"
    }
  }

  sink "file" {
    config = {
      path = "/vault/token"
    }
  }
}

template {
  destination = "/vault/secrets/app.env"
  contents = <<EOH
{{- with secret "kv/data/platform/nats/orchestrator" -}}
NATS_USER={{ .Data.data.username }}
NATS_PASS={{ .Data.data.password }}
{{- end -}}
{{- with secret "kv/data/health/fhir/orchestrator" -}}
FHIR_SYSTEM_TOKEN={{ .Data.data.system_token }}
FHIR_CLIENT_ID={{ .Data.data.client_id }}
FHIR_CLIENT_SECRET={{ .Data.data.client_secret }}
{{- end -}}
EOH
  command = "kill -HUP $(cat /tmp/vault-agent.pid)"
}
