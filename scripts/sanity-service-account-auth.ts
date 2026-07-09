import got from 'got';
import { CookieJar } from 'tough-cookie';

interface LoginServiceAccountOptions {
  email: string;
  password: string;
  recaptchaBypassKey: string;
  apiHost: string;
}

class RedirectInterceptedError extends Error {
  constructor() {
    super('Sanity auth redirect intercepted');
  }
}

export async function loginServiceAccount({
  email,
  password,
  recaptchaBypassKey,
  apiHost,
}: LoginServiceAccountOptions): Promise<string> {
  const accountsHost = apiHost.replace('://api.', '://accounts.');
  const cookieJar = new CookieJar();
  const client = got.extend({ cookieJar });

  const loginResponse = await client.post(`${accountsHost}/api/v1/login`, {
    json: {
      username: email,
      password,
      reCaptchaToken: recaptchaBypassKey,
    },
    throwHttpErrors: false,
  });

  if (loginResponse.statusCode !== 200) {
    throw new Error(`Service account login failed (${loginResponse.statusCode}): ${loginResponse.body}`);
  }

  const loginUrl = new URL(`${apiHost}/v1/auth/login/sanity`);
  loginUrl.searchParams.set('type', 'token');
  loginUrl.searchParams.set('origin', 'http://localhost:0');

  let fetchUrl: string | undefined;

  try {
    await client.get(loginUrl.toString(), {
      hooks: {
        beforeRedirect: [
          (_updatedOptions, response) => {
            const location = response.headers.location;
            if (typeof location !== 'string') {
              return;
            }

            const redirectUrl = new URL(location, loginUrl);
            if (redirectUrl.protocol === 'https:') {
              return;
            }

            fetchUrl = redirectUrl.searchParams.get('url') ?? undefined;
            throw new RedirectInterceptedError();
          },
        ],
      },
    });
  } catch (error) {
    if (!(error instanceof Error && error.cause instanceof RedirectInterceptedError)) {
      throw error;
    }
  }

  if (!fetchUrl) {
    throw new Error('Service account login failed: OAuth flow did not return a fetch URL');
  }

  const { token } = await client.get(fetchUrl).json<{ token?: string }>();
  if (!token) {
    throw new Error('Service account login failed: no token in fetch response');
  }

  return token;
}
