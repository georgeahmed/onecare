export interface MeshSendDocumentPayload {
  workflowId: string;
  mexWorkflowId: string;
  mexAckWorkflowId?: string;
  mexTo: string;
  mexLocalId: string;
  senderMailbox: string;
  subject?: string;
  pdf: {
    contentType: string;
    data: Uint8Array;
    filename?: string;
  };
  bundle: Record<string, unknown>;
}

export interface MeshSendDocumentResult {
  messageId: string;
  mexLocalId: string;
}

export interface MeshClient {
  sendDocument(payload: MeshSendDocumentPayload): Promise<MeshSendDocumentResult>;
}
