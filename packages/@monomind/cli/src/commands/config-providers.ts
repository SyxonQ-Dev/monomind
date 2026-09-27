import { output } from '../output.js';
import { configManager } from '../services/config-file-manager.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// List providers
export const providersCommand: Command = {
  name: 'providers',
  description: 'Manage AI providers',
  options: [
    {
      name: 'add',
      short: 'a',
      description: 'Add provider',
      type: 'string',
    },
    {
      name: 'remove',
      short: 'r',
      description: 'Remove provider',
      type: 'string',
    },
    {
      name: 'enable',
      description: 'Enable provider',
      type: 'string',
    },
    {
      name: 'disable',
      description: 'Disable provider',
      type: 'string',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const defaultProviders = [
      {
        name: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        priority: 1,
        enabled: true,
        status: 'Active',
      },
      {
        name: 'openrouter',
        model: 'claude-3.5-sonnet',
        priority: 2,
        enabled: false,
        status: 'Disabled',
      },
      { name: 'ollama', model: 'llama3.2', priority: 3, enabled: false, status: 'Disabled' },
      {
        name: 'gemini',
        model: 'gemini-2.0-flash',
        priority: 4,
        enabled: false,
        status: 'Disabled',
      },
    ];

    // Handle mutation flags
    const addProvider = (ctx.flags.add as string | undefined)?.slice(0, 64);
    const removeProvider = (ctx.flags.remove as string | undefined)?.slice(0, 64);
    const enableProvider = (ctx.flags.enable as string | undefined)?.slice(0, 64);
    const disableProvider = (ctx.flags.disable as string | undefined)?.slice(0, 64);

    if (addProvider || removeProvider || enableProvider || disableProvider) {
      // Read current providers from config
      let currentProviders =
        (configManager.get(ctx.cwd, 'providers') as Array<Record<string, unknown>>) || [];
      if (!Array.isArray(currentProviders)) currentProviders = [];

      if (addProvider) {
        const exists = currentProviders.some((p) => p.name === addProvider);
        if (exists) {
          output.printError(`Provider '${addProvider}' already exists`);
          return { success: false, exitCode: 1 };
        }
        currentProviders.push({
          name: addProvider,
          enabled: true,
          priority: currentProviders.length + 1,
        });
        output.writeln(output.success(`Added provider: ${addProvider}`));
      }
      if (removeProvider) {
        const before = currentProviders.length;
        currentProviders = currentProviders.filter((p) => p.name !== removeProvider);
        if (currentProviders.length === before) {
          output.printError(`Provider '${removeProvider}' not found`);
          return { success: false, exitCode: 1 };
        }
        output.writeln(output.success(`Removed provider: ${removeProvider}`));
      }
      if (enableProvider) {
        const p = currentProviders.find((p) => p.name === enableProvider);
        if (p) {
          p.enabled = true;
          output.writeln(output.success(`Enabled provider: ${enableProvider}`));
        } else {
          output.printError(`Provider '${enableProvider}' not found`);
          return { success: false, exitCode: 1 };
        }
      }
      if (disableProvider) {
        const p = currentProviders.find((p) => p.name === disableProvider);
        if (p) {
          p.enabled = false;
          output.writeln(output.success(`Disabled provider: ${disableProvider}`));
        } else {
          output.printError(`Provider '${disableProvider}' not found`);
          return { success: false, exitCode: 1 };
        }
      }

      try {
        configManager.set(ctx.cwd, 'providers', currentProviders);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        output.printError(`Failed to save providers: ${message}`);
        return { success: false, exitCode: 1 };
      }
      return { success: true, data: currentProviders };
    }

    // Read providers from config, fall back to defaults
    const configuredProviders = configManager.get(ctx.cwd, 'providers') as
      | Array<Record<string, unknown>>
      | undefined;
    const providers =
      Array.isArray(configuredProviders) && configuredProviders.length > 0
        ? configuredProviders.map((p, i) => ({
            name: String(p.name || ''),
            model: String(p.model || ''),
            priority: Number(p.priority || i + 1),
            enabled: p.enabled !== false,
            status: p.enabled !== false ? 'Active' : 'Disabled',
          }))
        : defaultProviders;

    if (ctx.flags.format === 'json') {
      output.printJson(providers);
      return { success: true, data: providers };
    }

    output.writeln();
    output.writeln(output.bold('AI Providers'));
    output.writeln();

    output.printTable({
      columns: [
        { key: 'name', header: 'Provider', width: 12 },
        { key: 'model', header: 'Model', width: 25 },
        { key: 'priority', header: 'Priority', width: 10, align: 'right' },
        {
          key: 'status',
          header: 'Status',
          width: 10,
          format: (v) => {
            if (v === 'Active') return output.success(String(v));
            return output.dim(String(v));
          },
        },
      ],
      data: providers,
    });

    output.writeln();
    output.writeln(output.dim('Use --add, --remove, --enable, --disable to manage providers'));

    return { success: true, data: providers };
  },
};
