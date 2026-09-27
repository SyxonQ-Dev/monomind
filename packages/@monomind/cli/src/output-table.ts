/**
 * CLI Output Formatter — table rendering
 *
 * Split out of output.ts (file-size sweep). Pure move: the method bodies are
 * unchanged; the formatter previously reached via `this` is now passed in
 * explicitly by the caller.
 */

import type { OutputFormatter } from './output.js';
import type { TableColumn, TableOptions } from './types.js';

export function renderTable(formatter: OutputFormatter, options: TableOptions): string {
  const { columns, data, border = true, header = true, padding = 1, maxWidth } = options;

  // Calculate column widths
  const widths = calculateColumnWidths(columns, data, maxWidth);

  const lines: string[] = [];
  const pad = ' '.repeat(padding);

  // Border characters
  const borderChars = border
    ? {
        topLeft: '+',
        topRight: '+',
        bottomLeft: '+',
        bottomRight: '+',
        horizontal: '-',
        vertical: '|',
        leftT: '+',
        rightT: '+',
        topT: '+',
        bottomT: '+',
        cross: '+',
      }
    : {
        topLeft: '',
        topRight: '',
        bottomLeft: '',
        bottomRight: '',
        horizontal: '',
        vertical: ' ',
        leftT: '',
        rightT: '',
        topT: '',
        bottomT: '',
        cross: '',
      };

  // Top border
  if (border) {
    lines.push(createBorderLine(widths, borderChars, 'top', padding));
  }

  // Header row
  if (header) {
    const headerRow = columns
      .map((col, i) => {
        const text = truncate(col.header, widths[i]);
        return pad + alignText(formatter.bold(text), widths[i], col.align) + pad;
      })
      .join(borderChars.vertical);

    lines.push(`${borderChars.vertical}${headerRow}${borderChars.vertical}`);

    // Header separator
    if (border) {
      lines.push(createBorderLine(widths, borderChars, 'middle', padding));
    }
  }

  // Data rows
  for (const row of data) {
    const rowCells = columns
      .map((col, i) => {
        let value = row[col.key];

        // Apply formatter if provided
        if (col.format) {
          value = col.format(value);
        } else {
          value = String(value ?? '');
        }

        const text = truncate(String(value), widths[i]);
        return pad + alignText(text, widths[i], col.align) + pad;
      })
      .join(borderChars.vertical);

    lines.push(`${borderChars.vertical}${rowCells}${borderChars.vertical}`);
  }

  // Bottom border
  if (border) {
    lines.push(createBorderLine(widths, borderChars, 'bottom', padding));
  }

  return lines.join('\n');
}

function calculateColumnWidths(
  columns: TableColumn[],
  data: Record<string, unknown>[],
  maxWidth?: number,
): number[] {
  const widths = columns.map((col, _i) => {
    // Start with header width
    let width = col.header.length;

    // Check all data values
    for (const row of data) {
      let value = row[col.key];
      if (col.format) {
        value = col.format(value);
      }
      const len = stripAnsi(String(value ?? '')).length;
      width = Math.max(width, len);
    }

    // Apply column-specific width limit
    if (col.width) {
      width = Math.min(width, col.width);
    }

    return width;
  });

  // Apply max width constraint
  if (maxWidth) {
    const totalWidth = widths.reduce((a, b) => a + b, 0) + columns.length * 3 + 1;
    if (totalWidth > maxWidth) {
      const reduction = (totalWidth - maxWidth) / columns.length;
      return widths.map((w) => Math.max(3, Math.floor(w - reduction)));
    }
  }

  return widths;
}

function createBorderLine(
  widths: number[],
  chars: Record<string, string>,
  position: 'top' | 'middle' | 'bottom',
  padding: number,
): string {
  const cellWidth = (w: number) => chars.horizontal.repeat(w + padding * 2);
  const cells = widths
    .map(cellWidth)
    .join(position === 'top' ? chars.topT : position === 'bottom' ? chars.bottomT : chars.cross);

  const left =
    position === 'top' ? chars.topLeft : position === 'bottom' ? chars.bottomLeft : chars.leftT;
  const right =
    position === 'top' ? chars.topRight : position === 'bottom' ? chars.bottomRight : chars.rightT;

  return `${left}${cells}${right}`;
}

function alignText(
  text: string,
  width: number,
  align: 'left' | 'center' | 'right' = 'left',
): string {
  const len = stripAnsi(text).length;
  const padding = width - len;

  if (padding <= 0) return text;

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + text;
    case 'center': {
      const left = Math.floor(padding / 2);
      const right = padding - left;
      return ' '.repeat(left) + text + ' '.repeat(right);
    }
    default:
      return text + ' '.repeat(padding);
  }
}

function truncate(text: string, maxLength: number): string {
  const stripped = stripAnsi(text);
  if (stripped.length <= maxLength) return text;
  return `${stripped.slice(0, maxLength - 3)}...`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
