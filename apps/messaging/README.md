# Messaging Service — GP Connect Send Document

The messaging service exposes a `POST /messaging/send-document` endpoint that packages triage summaries as ITK3/MESH payloads and delivers them to the patient’s registered practice via GP Connect Send Document v2.0. The service performs the following steps:

1. Validates the ingress payload against `schemas/messaging/send-document-request.json`.
2. Resolves the originating `Task` and `Patient` resources from FHIR to obtain the NHS number, DOB, surname, and registered practice ODS code (for `mex-to`).
3. Downloads the referenced PDF (max size defined by config), attaches the supplied Composition bundle, and builds the ITK3 payload.
4. Publishes lifecycle events (`messaging.senddoc.requested`, `messaging.senddoc.sent`) and updates the originating `Task` with audit metadata and MESH identifiers.
5. Returns the generated `messageId`, `mexLocalId`, and an `ackDueAt` timestamp derived from the configured ACK timeout.

## Configuration

```json
{
  "messaging": {
    "send_document": {
      "mesh": {
        "workflow_id": "GPCONNECT_SEND_DOCUMENT",
        "ack_workflow_id": "GPCONNECT_SEND_DOCUMENT_ACK",
        "sender_mailbox": "YOUR_MESH_ID",
        "ack_timeout_minutes": 30,
        "max_retries": 5,
        "backoff_schedule": ["PT1M", "PT5M", "PT15M", "PT1H", "PT3H"]
      },
      "pds_lookup": true,
      "pdf_max_mb": 10
    }
  }
}
```

| Config key | Description |
| --- | --- |
| `mesh.workflow_id` | Workflow ID used for the primary Send Document message (`GPCONNECT_SEND_DOCUMENT`). |
| `mesh.ack_workflow_id` | Workflow ID expected in ACK/NACK responses. |
| `mesh.sender_mailbox` | MESH mailbox of the sending organisation. |
| `mesh.ack_timeout_minutes` | Minutes before the send operation is treated as overdue (used for retry/alerting). |
| `mesh.max_retries` | Maximum retry attempts for NACK/timeout scenarios. |
| `mesh.backoff_schedule` | ISO8601 durations (oldest first) controlling the retry schedule. |
| `pds_lookup` | If `true`, the service requires a registered practice ODS code (via PDS/FHIR). |
| `pdf_max_mb` | Maximum allowed PDF size. |

## Event Topics

| Topic | Schema | Description |
| --- | --- | --- |
| `messaging.senddoc.requested` | `schemas/messaging/send-document-requested.json` | Emitted once the request is accepted and resolved to a patient/task. |
| `messaging.senddoc.sent` | `schemas/messaging/send-document-sent.json` | Emitted after a MESH message ID is returned. |
| `messaging.senddoc.ack` | `schemas/messaging/send-document-ack.json` | Reserved for future ACK listeners. |
| `messaging.senddoc.nack` | `schemas/messaging/send-document-nack.json` | Reserved for future NACK listeners. |
| `messaging.senddoc.retry` | `schemas/messaging/send-document-retry.json` | Published when the service schedules a retry. |

## Example Request

```http
POST /messaging/send-document HTTP/1.1
Content-Type: application/json
x-correlation-id: corr-123

{
  "taskId": "Task/12345",
  "pdfUrl": "https://object-store.local/documents/task-12345.pdf",
  "compositionBundleRef": "Bundle/triage-summary-12345"
}
```

```json
200 OK
{
  "status": "accepted",
  "messageId": "20250101-ABC123",
  "mexLocalId": "0fd83c28-56ff-4bb3-a7e0-2ea0c6a9241a",
  "taskId": "Task/12345",
  "ackDueAt": "2025-01-01T10:15:00.000Z",
  "correlationId": "corr-123"
}
```

## Testing

Run unit tests for the messaging service with:

```bash
npm run --workspace @onecare/app-messaging test
```

The tests cover happy-path document dispatch, validation failures, and Task update/audit behaviour.
