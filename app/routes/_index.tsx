import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider,
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
  BlockStack,
} from "@shopify/polaris";
import { useState } from "react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { login } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return login(request);
};

export default function Auth() {
  const [shop, setShop] = useState("");

  return (
    <PolarisAppProvider i18n={{}}>
      <Page>
        <Card>
          <Form method="post">
            <FormLayout>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  AdPilot — Social Media Command Center
                </Text>
                <Text as="p" variant="bodyMd">
                  Log in to install the app on your store.
                </Text>
                <TextField
                  label="Shop domain"
                  helpText="Example: my-store.myshopify.com"
                  value={shop}
                  onChange={setShop}
                  autoComplete="off"
                  name="shop"
                />
                <Button submit variant="primary">
                  Log in
                </Button>
              </BlockStack>
            </FormLayout>
          </Form>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
