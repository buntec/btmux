import { useMemo } from 'react';
import Papa from 'papaparse';
import { useFileStore } from '@/state/fileStore';
import { Placeholder } from '../Placeholder';

export function CsvPreview() {
  const fileContent = useFileStore((s) => s.fileContent);

  const data = useMemo(() => {
    if (!fileContent) return { headers: [], rows: [] };
    const result = Papa.parse<string[]>(fileContent.content, {
      header: false,
      skipEmptyLines: true,
    });
    const rows = result.data;
    if (rows.length === 0) return { headers: [], rows: [] };
    return { headers: rows[0], rows: rows.slice(1) };
  }, [fileContent]);

  if (!data.headers.length) {
    return <Placeholder>Empty CSV file</Placeholder>;
  }

  return (
    <div className="overflow-auto rounded border border-border">
      <table className="w-full">
        <thead className="bg-muted">
          <tr>
            {data.headers.map((h, i) => (
              <th key={i} className="whitespace-nowrap border-b border-border px-3 py-2 text-left font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.slice(0, 500).map((row, i) => (
            <tr key={i} className="border-b border-border last:border-0 hover:bg-overlay-hover">
              {row.map((cell, j) => (
                <td key={j} className="whitespace-nowrap px-3 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length > 500 && (
        <div className="p-2 text-center text-xs text-secondary">Showing first 500 of {data.rows.length} rows</div>
      )}
    </div>
  );
}
