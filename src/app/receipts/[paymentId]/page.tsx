import { notFound, redirect } from 'next/navigation';
import PrintButton from '@/components/PrintButton';
import { ApiError, currentUserOrNull, hasPermission, type Actor } from '@/lib/api';
import { getReceipt } from '@/lib/services/collections';
import { formatDate, inr } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Props = { params: Promise<{ paymentId: string }> };

/**
 * Printable receipt. Deliberately plain and unpadded so the browser's own
 * print-to-PDF produces clean stationery.
 */
export default async function ReceiptPage({ params }: Props) {
  const { paymentId } = await params;

  const user = await currentUserOrNull();
  if (!user) redirect('/login');
  if (!hasPermission(user, 'collections.view')) notFound();

  const actor: Actor = {
    user,
    ip: null,
    userAgent: null,
    path: `/receipts/${paymentId}`,
    method: 'GET',
  };

  let receipt: Awaited<ReturnType<typeof getReceipt>>;
  try {
    receipt = await getReceipt(actor, paymentId);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) notFound();
    throw err;
  }

  return (
    <div className="min-h-screen bg-white px-8 py-10 text-[#111] print:px-0 print:py-0">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-start justify-between border-b-2 border-[#111] pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Payment Receipt</h1>
            <p className="mt-0.5 text-sm text-neutral-600">This is a computer-generated receipt.</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold">{receipt.receiptNo}</p>
            <p className="text-xs text-neutral-600">{formatDate(receipt.receiptDate)}</p>
          </div>
        </div>

        {receipt.voided && (
          <div className="mb-6 border-2 border-red-600 p-3 text-center text-sm font-bold uppercase tracking-wide text-red-700">
            This receipt has been voided
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Received from
            </dt>
            <dd className="mt-0.5 font-semibold">{receipt.customerName}</dd>
            {receipt.customerPhone && (
              <dd className="text-neutral-600">{receipt.customerPhone}</dd>
            )}
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Property
            </dt>
            <dd className="mt-0.5 font-semibold">{receipt.projectName}</dd>
            <dd className="text-neutral-600">
              {receipt.bookingNo}
              {receipt.unitLabel ? ` · ${receipt.unitLabel}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Sale value
            </dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{inr(receipt.saleValue)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Payment mode
            </dt>
            <dd className="mt-0.5 font-semibold capitalize">
              {receipt.method.replace(/_/g, ' ').toLowerCase()}
            </dd>
            {receipt.reference && <dd className="text-neutral-600">Ref: {receipt.reference}</dd>}
          </div>
        </dl>

        <div className="mt-8 border-t border-neutral-300 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Amount received
          </p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{inr(receipt.amount)}</p>
          <p className="mt-1 text-sm text-neutral-700">Rupees {receipt.amountInWords} only</p>
        </div>

        {receipt.allocations.length > 0 && (
          <div className="mt-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Applied to
            </p>
            <table className="mt-2 w-full text-sm">
              <tbody>
                {receipt.allocations.map((a, i) => (
                  <tr key={`${a.name}-${i}`} className="border-b border-neutral-200 last:border-0">
                    <td className="py-1.5">{a.name}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">{inr(a.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-10 flex items-end justify-between text-xs text-neutral-600">
          <div>
            <p>Issued by {receipt.issuedBy ?? 'the office'}</p>
            <p className="mt-0.5">Printed {formatDate(receipt.issuedAt, 'dd MMM yyyy, h:mm a')}</p>
          </div>
          <div className="text-right">
            <div className="h-10 w-52 border-b border-neutral-400" />
            <p className="mt-1">Authorised signatory</p>
          </div>
        </div>

        <PrintButton />
      </div>
    </div>
  );
}
