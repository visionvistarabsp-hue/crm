'use client';

/**
 * Print trigger for the receipt page. Kept as a tiny client component so the
 * receipt itself stays a server-rendered, print-clean document.
 */
export default function PrintButton() {
  return (
    <div className="mt-6 print:hidden">
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-xl bg-[#111] px-4 py-2 text-sm font-semibold text-white"
      >
        Print / Save as PDF
      </button>
      <p className="mt-2 text-xs text-neutral-500">
        Use your browser&apos;s print dialog and choose &ldquo;Save as PDF&rdquo; to keep a copy.
      </p>
    </div>
  );
}
