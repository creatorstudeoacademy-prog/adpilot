import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  EmptyState,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATUS_TONE: Record<string, "info" | "success" | "critical" | undefined> = {
  scheduled: "info",
  published: "success",
  failed: "critical",
  draft: undefined,
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const posts = await prisma.scheduledPost.findMany({
    where: { shop: session.shop },
    include: { socialAccount: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return json({
    posts: posts.map((p) => ({
      id: p.id,
      content: p.content.slice(0, 80) + (p.content.length > 80 ? "…" : ""),
      pageName: p.socialAccount.pageName,
      mediaType: p.mediaType,
      platforms: JSON.parse(p.platforms) as string[],
      status: p.status,
      scheduledAt: p.scheduledAt?.toISOString() ?? null,
      publishedAt: p.publishedAt?.toISOString() ?? null,
      error: p.error,
      createdAt: p.createdAt.toISOString(),
    })),
  });
};

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function ScheduledPage() {
  const { posts } = useLoaderData<typeof loader>();

  const rows = posts.map((p) => [
    p.content || "(media only)",
    p.pageName,
    p.mediaType,
    p.platforms.join(", "),
    <Badge key={`s-${p.id}`} tone={STATUS_TONE[p.status]}>
      {p.status}
    </Badge>,
    formatDate(p.scheduledAt ?? p.publishedAt),
  ]);

  return (
    <Page
      title="Posts"
      subtitle="Scheduled and published posts"
      primaryAction={{ content: "Compose new", url: "/app/compose" }}
    >
      <BlockStack gap="500">
        {posts.length === 0 ? (
          <Card>
            <EmptyState
              heading="No posts yet"
              action={{ content: "Compose your first post", url: "/app/compose" }}
              image=""
            >
              <Text as="p" variant="bodyMd">
                Write a post and publish it now or schedule it for later.
              </Text>
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <DataTable
              columnContentTypes={[
                "text",
                "text",
                "text",
                "text",
                "text",
                "text",
              ]}
              headings={[
                "Content",
                "Account",
                "Type",
                "Platforms",
                "Status",
                "Date",
              ]}
              rows={rows}
            />
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
