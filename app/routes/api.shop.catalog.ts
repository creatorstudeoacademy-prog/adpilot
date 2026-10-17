import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";

interface ProductNode {
  id: string;
  title: string;
  description: string;
  featuredImage?: { url: string } | null;
  priceRangeV2?: {
    minVariantPrice?: { amount: string; currencyCode: string } | null;
  } | null;
}

interface CollectionNode {
  id: string;
  title: string;
  description: string;
  image?: { url: string } | null;
}

/**
 * GET /api/shop/catalog — list store products + collections for the
 * Compose picker. Returns { products, collections }.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const [prodRes, collRes] = await Promise.all([
    admin.graphql(
      `#graphql
      query {
        products(first: 50, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id
              title
              description(truncateAt: 200)
              featuredImage { url }
              priceRangeV2 { minVariantPrice { amount currencyCode } }
            }
          }
        }
      }`,
    ),
    admin.graphql(
      `#graphql
      query {
        collections(first: 50, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id
              title
              description(truncateAt: 200)
              image { url }
            }
          }
        }
      }`,
    ),
  ]);

  const prodJson = (await prodRes.json()) as {
    data?: { products?: { edges?: Array<{ node: ProductNode }> } };
  };
  const collJson = (await collRes.json()) as {
    data?: { collections?: { edges?: Array<{ node: CollectionNode }> } };
  };

  const products = (prodJson.data?.products?.edges ?? []).map(({ node }) => ({
    id: node.id,
    title: node.title,
    description: node.description ?? "",
    image: node.featuredImage?.url ?? "",
    price: node.priceRangeV2?.minVariantPrice
      ? `${node.priceRangeV2.minVariantPrice.currencyCode} ${node.priceRangeV2.minVariantPrice.amount}`
      : "",
  }));

  const collections = (collJson.data?.collections?.edges ?? []).map(({ node }) => ({
    id: node.id,
    title: node.title,
    description: node.description ?? "",
    image: node.image?.url ?? "",
  }));

  return json({ products, collections });
};
