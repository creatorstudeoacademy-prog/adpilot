/**
 * PixelPro — storefront event layer.
 *
 * Reads the JSON config injected by the pixels.liquid block and fires
 * standard ecommerce events to every configured pixel:
 *   PageView · ViewContent · AddToCart · InitiateCheckout · Purchase
 *
 * Everything is defensive: each pixel library is checked before use, and all
 * errors are swallowed so a misbehaving pixel can never break the storefront.
 */
(function () {
  "use strict";

  function getConfig() {
    try {
      var el = document.querySelector("script[data-pixelpro-config]");
      if (!el) return null;
      return JSON.parse(el.textContent || "{}");
    } catch (e) {
      return null;
    }
  }

  var cfg = getConfig();
  if (!cfg) return;

  function safe(fn) {
    try {
      fn();
    } catch (e) {
      /* a pixel must never break the storefront */
    }
  }

  /* ---------- per-pixel event helpers ---------- */

  function metaTrack(event, params) {
    if (!cfg.meta || typeof window.fbq !== "function") return;
    safe(function () {
      window.fbq("track", event, params || {});
    });
  }

  function tiktokTrack(event, params) {
    if (!cfg.tiktok || typeof window.ttq === "undefined") return;
    safe(function () {
      window.ttq.track(event, params || {});
    });
  }

  function googleEvent(event, params) {
    if (!cfg.google || typeof window.gtag !== "function") return;
    safe(function () {
      window.gtag("event", event, params || {});
    });
  }

  function snapTrack(event, params) {
    if (!cfg.snapchat || typeof window.snaptr !== "function") return;
    safe(function () {
      window.snaptr("track", event, params || {});
    });
  }

  function money(value) {
    var n = Number(value);
    return isNaN(n) ? 0 : Math.round(n * 100) / 100;
  }

  /* ---------- PageView (every page) ---------- */

  safe(function () {
    metaTrack("PageView");
    if (cfg.tiktok && typeof window.ttq !== "undefined") {
      safe(function () {
        window.ttq.page();
      });
    }
    googleEvent("page_view");
    snapTrack("PAGE_VIEW");
  });

  /* ---------- ViewContent (product pages) ---------- */

  if (cfg.isProduct && cfg.product) {
    var product = cfg.product;
    var viewParams = {
      content_ids: [String(product.id)],
      content_type: "product",
      content_name: product.title,
      value: money(product.price),
      currency: cfg.currency || "USD",
    };
    metaTrack("ViewContent", viewParams);
    tiktokTrack("ViewContent", {
      content_id: String(product.id),
      content_type: "product",
      value: money(product.price),
      currency: cfg.currency || "USD",
    });
    googleEvent("view_item", {
      currency: cfg.currency || "USD",
      value: money(product.price),
      items: [
        {
          item_id: String(product.id),
          item_name: product.title,
          price: money(product.price),
        },
      ],
    });
    snapTrack("VIEW_CONTENT", {
      item_ids: [String(product.id)],
      price: money(product.price),
      currency: cfg.currency || "USD",
    });
  }

  /* ---------- AddToCart ---------- */

  function fireAddToCart(id, title, price, quantity) {
    var params = {
      content_ids: [String(id)],
      content_type: "product",
      content_name: title,
      value: money(price) * (quantity || 1),
      currency: cfg.currency || "USD",
    };
    metaTrack("AddToCart", params);
    tiktokTrack("AddToCart", {
      content_id: String(id),
      content_type: "product",
      value: money(price) * (quantity || 1),
      currency: cfg.currency || "USD",
      quantity: quantity || 1,
    });
    googleEvent("add_to_cart", {
      currency: cfg.currency || "USD",
      value: money(price) * (quantity || 1),
      items: [
        {
          item_id: String(id),
          item_name: title,
          price: money(price),
          quantity: quantity || 1,
        },
      ],
    });
    snapTrack("ADD_CART", {
      item_ids: [String(id)],
      price: money(price),
      currency: cfg.currency || "USD",
    });
  }

  function productFromForm(form) {
    try {
      var idInput = form.querySelector('[name="id"]');
      var qtyInput = form.querySelector('[name="quantity"]');
      var id = idInput ? idInput.value : null;
      var qty = qtyInput ? parseInt(qtyInput.value, 10) || 1 : 1;
      if (!id) return null;
      var title =
        (cfg.isProduct && cfg.product ? cfg.product.title : null) ||
        document.title;
      var price =
        cfg.isProduct && cfg.product ? cfg.product.price : 0;
      return { id: id, title: title, price: price, quantity: qty };
    } catch (e) {
      return null;
    }
  }

  // Classic (non-AJAX) add-to-cart forms
  document.addEventListener(
    "submit",
    function (e) {
      var form = e.target;
      if (
        !form ||
        !form.action ||
        form.action.indexOf("/cart/add") === -1
      )
        return;
      var p = productFromForm(form);
      if (p) fireAddToCart(p.id, p.title, p.price, p.quantity);
    },
    true,
  );

  safe(function () {
    if (window.fetch) {
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        var url =
          typeof input === "string"
            ? input
            : input && input.url
              ? input.url
              : "";
        var body = init && init.body;
        if (typeof url === "string" && url.indexOf("/cart/add") !== -1) {
          var payload = null;
          try {
            payload =
              typeof body === "string" ? JSON.parse(body) : null;
          } catch (e) {
            payload = null;
          }
          return origFetch.apply(this, arguments).then(function (res) {
            var id =
              (payload && (payload.id || payload.variantId)) || null;
            var qty = (payload && payload.quantity) || 1;
            if (id) {
              var title =
                (cfg.isProduct && cfg.product ? cfg.product.title : null) ||
                document.title;
              var price =
                cfg.isProduct && cfg.product ? cfg.product.price : 0;
              fireAddToCart(id, title, price, qty);
            }
            return res;
          });
        }
        return origFetch.apply(this, arguments);
      };
    }
    if (window.XMLHttpRequest) {
      var origOpen = window.XMLHttpRequest.prototype.open;
      window.XMLHttpRequest.prototype.open = function (method, url) {
        this._pixelproUrl = url;
        return origOpen.apply(this, arguments);
      };
      var origSend = window.XMLHttpRequest.prototype.send;
      window.XMLHttpRequest.prototype.send = function (body) {
        var url = this._pixelproUrl || "";
        if (typeof url === "string" && url.indexOf("/cart/add") !== -1) {
          var payload = null;
          try {
            payload = typeof body === "string" ? JSON.parse(body) : null;
          } catch (e) {
            payload = null;
          }
          this.addEventListener("load", function () {
            var id =
              (payload && (payload.id || payload.variantId)) || null;
            var qty = (payload && payload.quantity) || 1;
            if (id) {
              var title =
                (cfg.isProduct && cfg.product ? cfg.product.title : null) ||
                document.title;
              var price =
                cfg.isProduct && cfg.product ? cfg.product.price : 0;
              fireAddToCart(id, title, price, qty);
            }
          });
        }
        return origSend.apply(this, arguments);
      };
    }
  });

  /* ---------- InitiateCheckout ---------- */

  function fireInitiateCheckout() {
    var params = {
      value: money(cfg.cartTotal),
      currency: cfg.currency || "USD",
      num_items: cfg.cartCount || 0,
    };
    metaTrack("InitiateCheckout", params);
    tiktokTrack("InitiateCheckout", {
      value: money(cfg.cartTotal),
      currency: cfg.currency || "USD",
    });
    googleEvent("begin_checkout", {
      currency: cfg.currency || "USD",
      value: money(cfg.cartTotal),
    });
    snapTrack("START_CHECKOUT", {
      price: money(cfg.cartTotal),
      currency: cfg.currency || "USD",
    });
  }

  if (cfg.isCart) {
    fireInitiateCheckout();
  }

  // Checkout buttons anywhere (cart drawer, product page express checkout)
  document.addEventListener(
    "click",
    function (e) {
      var el = e.target;
      while (el && el !== document) {
        if (
          el.matches &&
          (el.matches('[href*="/checkout"]') ||
            el.matches('[name="checkout"]') ||
            (el.textContent || "")
              .toLowerCase()
              .indexOf("checkout") !== -1)
        ) {
          fireInitiateCheckout();
          break;
        }
        el = el.parentElement;
      }
    },
    true,
  );

  /* ---------- Purchase (thank-you page, once per order) ---------- */

  if (cfg.isThankyou && cfg.order) {
    var orderKey = "pixelpro_purchase_" + String(cfg.order.id);
    var alreadyFired = false;
    safe(function () {
      alreadyFired = window.sessionStorage.getItem(orderKey) === "1";
    });
    if (!alreadyFired) {
      safe(function () {
        window.sessionStorage.setItem(orderKey, "1");
      });
      var items = (cfg.order.items || []).map(function (item) {
        return {
          item_id: String(item.id),
          item_name: item.title,
          price: money(item.price),
          quantity: item.quantity,
        };
      });
      var total = money(cfg.order.total);

      metaTrack("Purchase", {
        value: total,
        currency: cfg.currency || "USD",
      });
      tiktokTrack("Purchase", {
        value: total,
        currency: cfg.currency || "USD",
        contents: items.map(function (i) {
          return {
            content_id: i.item_id,
            content_type: "product",
            price: i.price,
            quantity: i.quantity,
          };
        }),
      });
      googleEvent("purchase", {
        currency: cfg.currency || "USD",
        value: total,
        transaction_id: String(cfg.order.id),
        items: items,
      });
      snapTrack("PURCHASE", {
        price: total,
        currency: cfg.currency || "USD",
        transaction_id: String(cfg.order.id),
      });
    }
  }
})();
