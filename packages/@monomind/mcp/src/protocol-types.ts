/**
 * @monoes/mcp - MCP 2025-11-25 Feature Types
 *
 * Resource, prompt, task, pagination, progress, sampling, roots, logging and
 * completion types. Re-exported from types.ts.
 */

import type { MCPError, RequestId } from './types.js';

// ============================================================================
// Resource Types (MCP 2025-11-25)
// ============================================================================

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  annotations?: ContentAnnotations;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // base64 encoded
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceListResult {
  resources: MCPResource[];
  nextCursor?: string;
}

export interface ResourceReadResult {
  contents: ResourceContent[];
}

// ============================================================================
// Prompt Types (MCP 2025-11-25)
// ============================================================================

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
}

export type PromptRole = 'user' | 'assistant';

export interface ContentAnnotations {
  audience?: Array<'user' | 'assistant'>;
  priority?: number;
  createdAt?: string;
  modifiedAt?: string;
}

export interface TextContent {
  type: 'text';
  text: string;
  annotations?: ContentAnnotations;
}

export interface ImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
  annotations?: ContentAnnotations;
}

export interface AudioContent {
  type: 'audio';
  data: string; // base64
  mimeType: string;
  annotations?: ContentAnnotations;
}

export interface EmbeddedResource {
  type: 'resource';
  resource: ResourceContent;
  annotations?: ContentAnnotations;
}

export type PromptContent = TextContent | ImageContent | AudioContent | EmbeddedResource;

export interface PromptMessage {
  role: PromptRole;
  content: PromptContent;
}

export interface PromptListResult {
  prompts: MCPPrompt[];
  nextCursor?: string;
}

export interface PromptGetResult {
  description?: string;
  messages: PromptMessage[];
}

// ============================================================================
// Task Types (MCP 2025-11-25 - Async Operations)
// ============================================================================

export type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MCPTask {
  id: string;
  state: TaskState;
  progress?: TaskProgress;
  result?: unknown;
  error?: MCPError;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface TaskProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface TaskResult {
  taskId: string;
  state: TaskState;
  progress?: TaskProgress;
  result?: unknown;
  error?: MCPError;
}

// ============================================================================
// Pagination Types (MCP 2025-11-25)
// ============================================================================

export interface PaginatedRequest {
  cursor?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
}

// ============================================================================
// Progress & Cancellation Types (MCP 2025-11-25)
// ============================================================================

export interface ProgressNotification {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

export interface CancellationParams {
  requestId: RequestId;
  reason?: string;
}

// ============================================================================
// Sampling Types (MCP 2025-11-25 - Server-initiated LLM)
// ============================================================================

export interface SamplingMessage {
  role: PromptRole;
  content: PromptContent;
}

export interface ModelPreferences {
  hints?: Array<{ name?: string }>;
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

export interface CreateMessageRequest {
  messages: SamplingMessage[];
  modelPreferences?: ModelPreferences;
  systemPrompt?: string;
  includeContext?: 'none' | 'thisServer' | 'allServers';
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateMessageResult {
  role: 'assistant';
  content: PromptContent;
  model: string;
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens';
}

// ============================================================================
// Roots Types (MCP 2025-11-25)
// ============================================================================

export interface Root {
  uri: string;
  name?: string;
}

export interface RootsListResult {
  roots: Root[];
}

// ============================================================================
// Logging Types (MCP 2025-11-25)
// ============================================================================

export type MCPLogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

export interface LoggingMessage {
  level: MCPLogLevel;
  logger?: string;
  data?: unknown;
}

// ============================================================================
// Completion Types (MCP 2025-11-25)
// ============================================================================

export interface CompletionReference {
  type: 'ref/prompt' | 'ref/resource';
  name?: string;
  uri?: string;
}

export interface CompletionArgument {
  name: string;
  value: string;
}

export interface CompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}
