'use client';

import dynamic from 'next/dynamic';

const InteractiveMap = dynamic(
  () => import('@/components/map/InteractiveMap'),
  { ssr: false, loading: () => (
    <div className="w-full h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="animate-spin text-4xl mb-4">⟳</div>
        <p className="text-gray-500">در حال بارگذاری نقشه...</p>
      </div>
    </div>
  )}
);

export default function Home() {
  return <InteractiveMap />;
}