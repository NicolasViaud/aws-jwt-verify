import * as outputs from "../outputs.json";
import { JSDOM, CookieJar } from "jsdom";
import * as assert from "node:assert";

export async function signIn() {
  const cookieJar = new CookieJar();

  /**
   * Initial GET request to ALB, should lead to redirect to Hosted UI
   */
  const albResponse1 = await fetch(
    outputs.AwsJwtCognitoTestStack.LoadBalancerUrl,
    {
      headers: {
        cookie: await cookieJar.getCookieString(
          outputs.AwsJwtCognitoTestStack.LoadBalancerUrl
        ),
      },
      redirect: "manual",
    }
  );
  assert.equal(albResponse1.status, 302);
  const cognitoHostedUiLocation1 = albResponse1.headers.get("location")!;
  assert.notEqual(cognitoHostedUiLocation1, null);

  albResponse1.headers.getSetCookie().forEach((cookie) => {
    cookieJar.setCookieSync(
      cookie,
      outputs.AwsJwtCognitoTestStack.LoadBalancerUrl
    );
  });

  /**
   * Initial GET request to Cognito Hosted UI, should lead to redirect to /login path
   */
  const cognitoResponse1 = await fetch(cognitoHostedUiLocation1, {
    headers: {
      cookie: await cookieJar.getCookieString(cognitoHostedUiLocation1),
    },
    redirect: "manual",
  });
  assert.equal(cognitoResponse1.status, 302);
  const cognitoHostedUiLocation2 = cognitoResponse1.headers.get("location")!;
  assert.notEqual(cognitoHostedUiLocation1, null);

  cognitoResponse1.headers.getSetCookie().forEach((cookie) => {
    cookieJar.setCookieSync(cookie, cognitoHostedUiLocation1);
  });

  /**
   * GET request to Cognito Hosted UI /login path
   */
  const cognitoResponse2 = await fetch(cognitoHostedUiLocation2, {
    headers: {
      cookie: await cookieJar.getCookieString(cognitoHostedUiLocation2),
    },
    redirect: "manual",
  });
  assert.equal(cognitoResponse2.status, 200);

  cognitoResponse2.headers.getSetCookie().forEach((cookie) => {
    cookieJar.setCookieSync(cookie, cognitoHostedUiLocation2);
  });

  const body = await cognitoResponse2.text();
  const html = new JSDOM(body);
  const form = html.window.document.querySelector("form") as HTMLFormElement;
  assert.notEqual(form, null);

  const csrfToken = form.querySelector(
    'input[name="_csrf"]'
  ) as HTMLInputElement;
  assert.notEqual(csrfToken, null);

  const cognitoHostedUiLocation3 = new URL(
    form.action,
    cognitoHostedUiLocation2
  ).href;

  /**
   * Simulate the submission of the form (POST) with username and password.
   * This should lead to a redirect to the ALB's idpresponse path (if username and password are ok)
   */
  const cognitoResponse3 = await fetch(cognitoHostedUiLocation3, {
    method: form.method,
    headers: {
      cookie: await cookieJar.getCookieString(cognitoHostedUiLocation3),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      _csrf: csrfToken.value,
      username: outputs.AwsJwtCognitoTestStack.UserPoolUser,
      password: outputs.AwsJwtCognitoTestStack.UserPoolUserPassword,
    }).toString(),
    redirect: "manual",
  });

  assert.equal(cognitoResponse3.status, 302);
  const albLocation2 = cognitoResponse3.headers.get("location")!;
  assert.notEqual(albLocation2, null);

  cognitoResponse3.headers.getSetCookie().forEach((cookie) => {
    cookieJar.setCookieSync(cookie, cognitoHostedUiLocation3);
  });

  /**
   * GET request to ALB idpresponse path, should lead to redirect to the original ALB path
   */
  const albResponse2 = await fetch(albLocation2, {
    headers: {
      cookie: await cookieJar.getCookieString(albLocation2),
    },
    redirect: "manual",
  });

  assert.equal(albResponse2.status, 302);
  const albLocation3 = albResponse2.headers.get("location")!;
  assert.notEqual(albLocation3, null);

  albResponse2.headers.getSetCookie().forEach((cookie) => {
    cookieJar.setCookieSync(cookie, albLocation2);
  });

  /**
   * GET request to ALB path, we are now signed in, and should get our payload back!
   */
  const albResponse3 = await fetch(albLocation3, {
    headers: {
      cookie: await cookieJar.getCookieString(albLocation3),
    },
    redirect: "manual",
  });

  assert.equal(albResponse3.status, 200);
  albResponse3.headers.getSetCookie().forEach((cookie) => {
    cookieJar.setCookieSync(cookie, albLocation3);
  });

  const albEventPayload = await albResponse3.json();

  const {
    "x-amzn-oidc-accesstoken": cognitoAccessToken,
    "x-amzn-oidc-data": albToken,
  } = albEventPayload.headers;

  return {
    cognitoAccessToken,
    albToken,
  };
}
