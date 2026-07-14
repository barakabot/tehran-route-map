import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

type RouteContext = {
  params: Promise<{ id: string }>;
};

async function ensureCustomerReportTable() {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CustomerReport" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "customerId" TEXT NOT NULL,
      "visitStatus" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "followUpDate" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "CustomerReport_customerId_fkey"
        FOREIGN KEY ("customerId") REFERENCES "Customer" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await db.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "CustomerReport_customerId_createdAt_idx"
    ON "CustomerReport"("customerId", "createdAt")
  `);
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id: customerId } = await context.params;
    const body = await request.json();
    const visitStatus = typeof body.visitStatus === 'string' ? body.visitStatus.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const followUpDateValue = typeof body.followUpDate === 'string' ? body.followUpDate.trim() : '';

    if (!visitStatus || !description) {
      return NextResponse.json(
        { error: 'نتیجه مراجعه و توضیحات گزارش الزامی است.' },
        { status: 400 }
      );
    }

    const customer = await db.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });

    if (!customer) {
      return NextResponse.json({ error: 'مشتری پیدا نشد.' }, { status: 404 });
    }

    await ensureCustomerReportTable();

    let followUpDate: Date | null = null;
    if (followUpDateValue) {
      followUpDate = new Date(`${followUpDateValue}T00:00:00`);
      if (Number.isNaN(followUpDate.getTime())) {
        return NextResponse.json({ error: 'تاریخ پیگیری معتبر نیست.' }, { status: 400 });
      }
    }

    const report = await db.customerReport.create({
      data: {
        customerId,
        visitStatus,
        description,
        followUpDate,
      },
    });

    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    console.error('Create customer report error:', error);
    return NextResponse.json({ error: 'ثبت گزارش انجام نشد.' }, { status: 500 });
  }
}
