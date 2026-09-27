/**
 * @monoes/mcp - MCP Server (request routing)
 *
 * Method dispatch plus the task, completion, logging and sampling handlers.
 */

import { MCPServerHandlers } from './server-handlers.js';
import type { MCPRequest, MCPResponse } from './types.js';
import { ErrorCodes } from './types.js';

export abstract class MCPServerRouting extends MCPServerHandlers {
  protected async routeRequest(request: MCPRequest, connectionId?: string): Promise<MCPResponse> {
    switch (request.method) {
      // Tool methods
      case 'tools/list':
        return this.handleToolsList(request);
      case 'tools/call':
        return this.handleToolsCall(request, connectionId);

      // Resource methods (MCP 2025-11-25)
      case 'resources/list':
        return this.handleResourcesList(request);
      case 'resources/read':
        return this.handleResourcesRead(request);
      case 'resources/subscribe':
        return this.handleResourcesSubscribe(request, connectionId);
      case 'resources/unsubscribe':
        return this.handleResourcesUnsubscribe(request, connectionId);

      // Prompt methods (MCP 2025-11-25)
      case 'prompts/list':
        return this.handlePromptsList(request);
      case 'prompts/get':
        return this.handlePromptsGet(request);

      // Task methods (MCP 2025-11-25)
      case 'tasks/status':
        return this.handleTasksStatus(request);
      case 'tasks/cancel':
        return this.handleTasksCancel(request);

      // Completion (MCP 2025-11-25)
      case 'completion/complete':
        return this.handleCompletion(request);

      // Logging (MCP 2025-11-25)
      case 'logging/setLevel':
        return this.handleLoggingSetLevel(request);

      // Sampling (MCP 2025-11-25)
      case 'sampling/createMessage':
        return this.handleSamplingCreateMessage(request, connectionId);

      // Utility
      case 'ping':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: { pong: true, timestamp: Date.now() },
        };

      default:
        // Check if it's a direct tool call
        if (this.toolRegistry.hasTool(request.method)) {
          return this.handleToolExecution(request, connectionId);
        }

        return this.createErrorResponse(
          request.id,
          ErrorCodes.METHOD_NOT_FOUND,
          `Method not found: ${request.method}`,
        );
    }
  }

  // ============================================================================
  // Task Handlers (MCP 2025-11-25)
  // ============================================================================

  private handleTasksStatus(request: MCPRequest): MCPResponse {
    const params = request.params as { taskId?: string } | undefined;

    if (params?.taskId) {
      const task = this.taskManager.getTask(params.taskId);
      if (!task) {
        return this.createErrorResponse(
          request.id,
          ErrorCodes.INVALID_PARAMS,
          `Task not found: ${params.taskId}`,
        );
      }
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: task,
      };
    }

    // Return all tasks
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { tasks: this.taskManager.getAllTasks() },
    };
  }

  private handleTasksCancel(request: MCPRequest): MCPResponse {
    const params = request.params as { taskId: string; reason?: string } | undefined;

    if (!params?.taskId) {
      return this.createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, 'Task ID is required');
    }

    const success = this.taskManager.cancelTask(params.taskId, params.reason);

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { success },
    };
  }

  // ============================================================================
  // Completion Handler (MCP 2025-11-25)
  // ============================================================================

  private handleCompletion(request: MCPRequest): MCPResponse {
    const params = request.params as
      | {
          ref: { type: string; name?: string; uri?: string };
          argument: { name: string; value: string };
        }
      | undefined;

    if (!params?.ref || !params?.argument) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INVALID_PARAMS,
        'Completion reference and argument are required',
      );
    }

    // Basic completion implementation - can be extended
    const completions: string[] = [];

    if (params.ref.type === 'ref/prompt') {
      // Get prompt argument completions
      const prompt = this.promptRegistry.getPrompt(params.ref.name || '');
      if (prompt?.arguments) {
        for (const arg of prompt.arguments) {
          if (arg.name === params.argument.name) {
            // Could add domain-specific completions here
          }
        }
      }
    } else if (params.ref.type === 'ref/resource') {
      // Get resource URI completions
      const { resources } = this.resourceRegistry.list();
      for (const resource of resources) {
        if (resource.uri.startsWith(params.argument.value)) {
          completions.push(resource.uri);
        }
      }
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        completion: {
          values: completions.slice(0, 10),
          total: completions.length,
          hasMore: completions.length > 10,
        },
      },
    };
  }

  // ============================================================================
  // Logging Handler (MCP 2025-11-25)
  // ============================================================================

  private handleLoggingSetLevel(request: MCPRequest): MCPResponse {
    const params = request.params as { level: string } | undefined;

    if (!params?.level) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INVALID_PARAMS,
        'Log level is required',
      );
    }

    // Update capabilities
    this.capabilities.logging = { level: params.level as 'debug' | 'info' | 'warn' | 'error' };

    this.logger.info('Log level updated', { level: params.level });

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { success: true },
    };
  }

  // ============================================================================
  // Sampling Handler (MCP 2025-11-25)
  // ============================================================================

  private async handleSamplingCreateMessage(
    request: MCPRequest,
    connectionId?: string,
  ): Promise<MCPResponse> {
    const params = request.params as
      | {
          messages: Array<{ role: string; content: { type: string; text?: string } }>;
          maxTokens: number;
          systemPrompt?: string;
          modelPreferences?: {
            hints?: Array<{ name?: string }>;
            intelligencePriority?: number;
            speedPriority?: number;
            costPriority?: number;
          };
          includeContext?: string;
          temperature?: number;
          stopSequences?: string[];
          metadata?: Record<string, unknown>;
        }
      | undefined;

    if (!params?.messages || !params?.maxTokens) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INVALID_PARAMS,
        'messages and maxTokens are required',
      );
    }

    // Check if sampling is available
    const available = await this.samplingManager.isAvailable();
    if (!available) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INTERNAL_ERROR,
        'No LLM provider available for sampling',
      );
    }

    try {
      const result = await this.samplingManager.createMessage(
        {
          messages: params.messages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content as any,
          })),
          maxTokens: params.maxTokens,
          systemPrompt: params.systemPrompt,
          modelPreferences: params.modelPreferences,
          includeContext: params.includeContext as 'none' | 'thisServer' | 'allServers' | undefined,
          temperature: params.temperature,
          stopSequences: params.stopSequences,
          metadata: params.metadata,
        },
        {
          sessionId: this.getSessionForConnection(connectionId)?.id || 'unknown',
          serverId: this.serverInfo.name,
        },
      );

      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
    } catch (error) {
      return this.createErrorResponse(
        request.id,
        ErrorCodes.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Sampling failed',
      );
    }
  }
}
