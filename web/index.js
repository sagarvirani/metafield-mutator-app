// @ts-check
import { join } from "path";
import { link, readFileSync } from "fs";

import express from "express";
import serveStatic from "serve-static";

import shopify from "./shopify.js";
import productCreator from "./product-creator.js";
import GDPRWebhookHandlers from "./gdpr.js";

const PORT = parseInt(
  process.env.BACKEND_PORT || process.env.PORT || "3000",
  10
);

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// Set up Shopify authentication and webhook handling
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: GDPRWebhookHandlers })
);

// If you are adding routes outside of the /api path, remember to
// also add a proxy rule for them in web/frontend/vite.config.js

app.use("/api/*", shopify.validateAuthenticatedSession());

app.use(express.json());

app.get("/api/products/count", async (_req, res) => {
  const countData = await shopify.api.rest.Product.count({
    session: res.locals.shopify.session,
    headers: {
      Accept: "application/json",
    },
  });
  res.status(200).send(countData);
});

app.get("/api/products/create/:collectionId", async (_req, res) => {
  try {
    const client = new shopify.api.clients.Rest({
      session: res.locals.shopify.session,
    });
    
    let collectionId = _req.params.collectionId;
    let pathVarialbe = `/collections/${collectionId}/products.json`;
    const productsPerPage = 1;
    
    let productData = await client.get({
      path: pathVarialbe,
      query: { 
        limit: productsPerPage,
      }
    });
    
    let productArray = [];
    let nextPageInfo = null;
    let prod;
    let c = 0;

    while(true) {
      
      prod = productData.body.products;
      productArray = productArray.concat(prod);
      
      const linkHeader = productData.headers["Link"];
      //console.log("link header =",linkHeader);
      nextPageInfo = extractPageInfo(linkHeader);
      //console.log("next page information =",nextPageInfo);

      if(nextPageInfo == null) {
        break;
      }
      else {
        const nextPageUrl = `${pathVarialbe}?limit=${productsPerPage}&page_info=${nextPageInfo}`;
        //console.log("next page url=", nextPageUrl);
        
        productData = await client.get({
          path: nextPageUrl,
          query: { 
            limit: productsPerPage,
            page_info: nextPageInfo,
          }
        });
      }
    }

    // Update the metafield for each product
    console.log("Updating the following products:");
    const updatedProducts = await Promise.all(
      productArray.map(async (product) => {
        const updatedProduct = await client.post({
          path: `/products/${product.id}/metafields.json`,
          data: {
            metafield: {
              namespace: "custom",
              key: "demo_counter",
              value: "1",
              type: "number_integer" 
            },
          },
        });
        console.log("Product ID & Title:", product.id, product.title);
        return updatedProduct;
      })
    );

    res.status(200).send("success");
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Extracts the 'page_info' parameter from the Link header
function extractPageInfo(linkHeader) {
  if (!linkHeader || linkHeader.length === 0) {
    return null;
  }

  const link = linkHeader.toString().split(',');
  const relRegex = /rel="next"/;
  const pageInfoRegex = /page_info=([^&>]+)/;
  
  for(let i=0; i < link.length; i++){
    if (relRegex.test(link[i])) {
      //console.log("link with rel=next",link[i]);
      const match = pageInfoRegex.exec(link[i]) ;
      if (match) {
        return match[1];
      }
    }
  }
  
  return null;
}

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  return res
    .status(200)
    .set("Content-Type", "text/html")
    .send(readFileSync(join(STATIC_PATH, "index.html")));
});

app.listen(PORT);
