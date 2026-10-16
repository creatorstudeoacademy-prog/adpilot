import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { runDuePostsPass } from "../lib/scheduler.server";
import { authenticate } from "../shopify.server";

/**
 * Manual trigger for the scheduled-post publishing worker.
 * Admin-authenticated; runs one worker pass and returns { published, failed }.
 * Used for testing — production publishing runs on the in-process interval.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  const result = await runDuePostsPass();
  return json(result);
}
