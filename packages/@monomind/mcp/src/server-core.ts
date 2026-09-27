/**
 * @monoes/mcp - MCP Server (core)
 *
 * Server state, sub-system wiring, public registry/metrics accessors,
 * per-connection session binding and event forwarding. Extended by the
 * handler layers and finally MCPServer (server.ts).
 */

import { EventEmitter } from 'node:events';
import { type ConnectionPool, createConnectionPool } from './connection-pool.js';
import { createPromptRegistry, type PromptRegistry } from './prompt-registry.js';
import { createRateLimiter, type RateLimiter } from './rate-limiter.js';
import { createResourceRegistry, type ResourceRegistry } from './resource-registry.js';
import { createSamplingManager, type LLMProvider, type SamplingManager } from './sampling.js';
import { createSessionManager, type SessionManager } from './session-manager.js';
import { createTaskManager, type TaskManager } from './task-manager.js';
import { createToolRegistry, type ToolRegistry } from './tool-registry.js';
import type {
  ILogger,
  ITransport,
  MCPCapabilities,
  MCPProtocolVersion,
  MCPResponse,
  MCPServerConfig,
  MCPServerMetrics,
  MCPSession,
  MCPTool,
} from './types.js';

const DEFAULT_CONFIG: Partial<MCPServerConfig> = {
  name: 'Monomind MCP Server V1',
  version: '3.0.0',
  transport: 'stdio',
  host: 'localhost',
  port: 3000,
  enableMetrics: true,
  enableCaching: true,
  cacheTTL: 10000,
  logLevel: 'info',
  requestTimeout: 30000,
  maxRequestSize: 10 * 1024 * 1024,
};

export abstract class MCPServerCore extends EventEmitter {
  protected readonly config: MCPServerConfig;
  protected readonly toolRegistry: ToolRegistry;
  protected readonly sessionManager: SessionManager;
  protected readonly resourceRegistry: ResourceRegistry;
  protected readonly promptRegistry: PromptRegistry;
  protected readonly taskManager: TaskManager;
  protected readonly connectionPool?: ConnectionPool;
  protected readonly rateLimiter: RateLimiter;
  protected readonly samplingManager: SamplingManager;
  protected transport?: ITransport;
  protected running = false;
  protected startTime?: Date;
  protected startupDuration?: number;
  // Fallback singleton session, used only for transports that are inherently
  // single-client (stdio, in-process) where the transport never supplies a
  // connectionId to handleRequest/handleNotification.
  protected currentSession?: MCPSession;
  // connectionId -> session, for multi-client transports (http, websocket).
  // Without this, every connection shared `currentSession` above and a
  // second client's `initialize` would silently reassign the session out
  // from under the first client (issue #93).
  protected readonly connectionSessions: Map<string, MCPSession> = new Map();
  // sessionId -> (uri -> subscriptionId). The registry-issued subscriptionId
  // must be retained so resources/unsubscribe (and session teardown) can call
  // resourceRegistry.unsubscribe(id) — without it callbacks leak and phantom
  // notifications fire after unsubscribe (issue #92).
  protected resourceSubscriptions: Map<string, Map<string, string>> = new Map();

  protected readonly serverInfo = {
    name: 'Monomind MCP Server V1',
    version: '3.0.0',
  };

  // MCP 2025-11-25 protocol version
  protected readonly protocolVersion: MCPProtocolVersion = {
    major: 2025,
    minor: 11,
    patch: 25,
  };

  // Full MCP 2025-11-25 capabilities
  protected capabilities: MCPCapabilities = {
    logging: { level: 'info' },
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    prompts: { listChanged: true },
    sampling: {},
  };

  protected requestStats = {
    total: 0,
    successful: 0,
    failed: 0,
    totalResponseTime: 0,
  };

  constructor(
    config: Partial<MCPServerConfig>,
    protected readonly logger: ILogger,
    protected readonly orchestrator?: unknown,
    protected readonly swarmCoordinator?: unknown,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as MCPServerConfig;

    this.toolRegistry = createToolRegistry(logger);
    this.sessionManager = createSessionManager(logger, {
      maxSessions: 100,
      sessionTimeout: 30 * 60 * 1000,
    });
    this.resourceRegistry = createResourceRegistry(logger, {
      enableSubscriptions: true,
      cacheEnabled: true,
      cacheTTL: 60000,
    });
    this.promptRegistry = createPromptRegistry(logger);
    this.taskManager = createTaskManager(logger, {
      maxConcurrentTasks: 10,
      taskTimeout: 300000,
    });
    this.rateLimiter = createRateLimiter(logger, {
      requestsPerSecond: 100,
      burstSize: 200,
      perSessionLimit: 50,
    });
    this.samplingManager = createSamplingManager(logger);

    if (this.config.connectionPool) {
      this.connectionPool = createConnectionPool(
        this.config.connectionPool,
        logger,
        this.config.transport,
      );
    }

    this.setupEventHandlers();
  }

  /**
   * Get resource registry for external registration
   */
  getResourceRegistry(): ResourceRegistry {
    return this.resourceRegistry;
  }

  /**
   * Get prompt registry for external registration
   */
  getPromptRegistry(): PromptRegistry {
    return this.promptRegistry;
  }

  /**
   * Get task manager for async operations
   */
  getTaskManager(): TaskManager {
    return this.taskManager;
  }

  /**
   * Get rate limiter for configuration
   */
  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  /**
   * Get sampling manager for LLM provider registration
   */
  getSamplingManager(): SamplingManager {
    return this.samplingManager;
  }

  /**
   * Register an LLM provider for sampling
   */
  registerLLMProvider(provider: LLMProvider, isDefault: boolean = false): void {
    this.samplingManager.registerProvider(provider, isDefault);
  }

  registerTool(tool: MCPTool): boolean {
    return this.toolRegistry.register(tool);
  }

  registerTools(tools: MCPTool[]): { registered: number; failed: string[] } {
    return this.toolRegistry.registerBatch(tools);
  }

  unregisterTool(name: string): boolean {
    return this.toolRegistry.unregister(name);
  }

  async getHealthStatus(): Promise<{
    healthy: boolean;
    error?: string;
    metrics?: Record<string, number>;
  }> {
    try {
      const transportHealth = this.transport
        ? await this.transport.getHealthStatus()
        : { healthy: false, error: 'Transport not initialized' };

      const sessionMetrics = this.sessionManager.getSessionMetrics();
      const poolStats = this.connectionPool?.getStats();

      const metrics: Record<string, number> = {
        registeredTools: this.toolRegistry.getToolCount(),
        totalRequests: this.requestStats.total,
        successfulRequests: this.requestStats.successful,
        failedRequests: this.requestStats.failed,
        totalSessions: sessionMetrics.total,
        activeSessions: sessionMetrics.active,
        ...(transportHealth.metrics || {}),
      };

      if (poolStats) {
        metrics.poolConnections = poolStats.totalConnections;
        metrics.poolIdleConnections = poolStats.idleConnections;
        metrics.poolBusyConnections = poolStats.busyConnections;
      }

      return {
        healthy: this.running && transportHealth.healthy,
        error: transportHealth.error,
        metrics,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  getMetrics(): MCPServerMetrics {
    const sessionMetrics = this.sessionManager.getSessionMetrics();
    const registryStats = this.toolRegistry.getStats();

    return {
      totalRequests: this.requestStats.total,
      successfulRequests: this.requestStats.successful,
      failedRequests: this.requestStats.failed,
      averageResponseTime:
        this.requestStats.total > 0
          ? this.requestStats.totalResponseTime / this.requestStats.total
          : 0,
      activeSessions: sessionMetrics.active,
      toolInvocations: Object.fromEntries(registryStats.topTools.map((t) => [t.name, t.calls])),
      errors: {},
      lastReset: this.startTime || new Date(),
      startupTime: this.startupDuration,
      uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
    };
  }

  getSessions(): MCPSession[] {
    return this.sessionManager.getActiveSessions();
  }

  getSession(sessionId: string): MCPSession | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * Resolve the session bound to a connection without creating one.
   * Multi-client transports (http, websocket) pass a `connectionId`, which is
   * looked up in `connectionSessions`. Single-client transports (stdio,
   * in-process) omit it, falling back to the `currentSession` singleton.
   */
  protected getSessionForConnection(connectionId?: string): MCPSession | undefined {
    if (connectionId) {
      return this.connectionSessions.get(connectionId);
    }
    return this.currentSession;
  }

  /**
   * Bind a newly-created session to a connection: per-connectionId when the
   * transport supports multiple clients, otherwise the singleton fallback.
   */
  protected bindSessionToConnection(session: MCPSession, connectionId?: string): void {
    if (connectionId) {
      this.connectionSessions.set(connectionId, session);
    } else {
      this.currentSession = session;
    }
  }

  /**
   * Tear down the session owned by a connection when the transport reports
   * that connection has closed — prevents closed clients' sessions (and any
   * resource subscriptions) from lingering until the idle-timeout sweep.
   */
  protected closeConnectionSession(connectionId: string): void {
    const session = this.connectionSessions.get(connectionId);
    this.connectionSessions.delete(connectionId);
    if (session) {
      // closeSession emits 'session:closed', which purges the session's
      // resource subscriptions (see setupEventHandlers).
      this.sessionManager.closeSession(session.id, 'Connection closed');
    }
  }

  /**
   * Detach every registry subscription owned by a session. Called whenever a
   * session ends (terminated, connection closed, expired, server stopped) so
   * no update callback outlives its session (issue #92).
   */
  protected purgeSessionSubscriptions(sessionId: string): void {
    const sessionSubs = this.resourceSubscriptions.get(sessionId);
    if (!sessionSubs) {
      return;
    }
    for (const subscriptionId of sessionSubs.values()) {
      this.resourceRegistry.unsubscribe(subscriptionId);
    }
    this.resourceSubscriptions.delete(sessionId);
  }

  // ============================================================================
  // Notification Sender
  // ============================================================================

  protected async sendNotification(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    if (this.transport?.sendNotification) {
      await this.transport.sendNotification({
        jsonrpc: '2.0',
        method,
        params,
      });
    }
  }

  protected getOrCreateSession(connectionId?: string): MCPSession {
    const existing = this.getSessionForConnection(connectionId);
    if (existing) {
      return existing;
    }

    // A client is calling a non-initialize method on a connection that never
    // sent `initialize` (or whose session already expired). Create a fresh
    // session bound to this specific connection rather than reusing/
    // overwriting another client's session.
    const session = this.sessionManager.createSession(this.config.transport);
    this.bindSessionToConnection(session, connectionId);
    return session;
  }

  protected createErrorResponse(
    id: string | number | null,
    code: number,
    message: string,
  ): MCPResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
  }

  private setupEventHandlers(): void {
    this.toolRegistry.on('tool:registered', (name) => {
      this.emit('tool:registered', name);
    });

    this.toolRegistry.on('tool:called', (data) => {
      this.emit('tool:called', data);
    });

    this.toolRegistry.on('tool:completed', (data) => {
      this.emit('tool:completed', data);
    });

    this.toolRegistry.on('tool:error', (data) => {
      this.emit('tool:error', data);
    });

    this.sessionManager.on('session:created', (session) => {
      this.emit('session:created', session);
    });

    this.sessionManager.on('session:closed', (data) => {
      this.purgeSessionSubscriptions(data.session.id);
      this.emit('session:closed', data);
    });

    this.sessionManager.on('session:expired', (session) => {
      this.purgeSessionSubscriptions(session.id);
      // Drop references to the expired session — otherwise `currentSession` /
      // `connectionSessions` keep pointing at a session the manager has
      // already reaped, and subsequent updateActivity calls fail silently
      // against the ghost (issue #93).
      if (this.currentSession?.id === session.id) {
        this.currentSession = undefined;
      }
      for (const [connectionId, s] of this.connectionSessions) {
        if (s.id === session.id) {
          this.connectionSessions.delete(connectionId);
        }
      }
      this.emit('session:expired', session);
    });
  }
}
