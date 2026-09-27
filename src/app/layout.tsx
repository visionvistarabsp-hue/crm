import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'SalesPoint CRM',
    template: '%s · SalesPoint CRM',
  },
  description: 'Real estate sales CRM — leads, bookings, commissions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}