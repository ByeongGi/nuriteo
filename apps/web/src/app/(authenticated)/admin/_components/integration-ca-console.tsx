"use client";

import {
  ApiError,
  activateIntegrationCa,
  listIntegrationCas,
  stageIntegrationCa,
} from "@nuriteo/api-client";
import type { IntegrationCaBundle, IntegrationCaType } from "@nuriteo/api-client";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";

interface IntegrationCaConsoleProps {
  readonly type: IntegrationCaType;
  readonly integrationId: string;
}

export function IntegrationCaConsole({ type, integrationId }: IntegrationCaConsoleProps) {
  const [items, setItems] = useState<readonly IntegrationCaBundle[]>();
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ readonly error: boolean; readonly text: string }>();

  async function load() {
    setPending(true);
    setMessage(undefined);
    try {
      const result = await listIntegrationCas(createBrowserApiClient(), type, integrationId);
      setItems(result.data.items);
      setVersion(result.data.version);
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setPending(false);
    }
  }

  async function stage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const pem = String(new FormData(form).get("pem") ?? "");
    form.reset();
    setPending(true);
    setMessage(undefined);
    try {
      const result = await stageIntegrationCa(createBrowserApiClient(), type, integrationId, version, pem, {
        csrfToken: readCsrfCredential(),
        idempotencyKey: crypto.randomUUID(),
      });
      setItems((current) => [result.data, ...(current ?? []).filter((item) => item.state !== "candidate")]);
      setVersion(result.data.version);
      setMessage({ error: false, text: "CA candidate stored. The certificate body was cleared from this browser." });
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setPending(false);
    }
  }

  async function activate(candidate: IntegrationCaBundle) {
    setPending(true);
    setMessage(undefined);
    try {
      await activateIntegrationCa(createBrowserApiClient(), type, integrationId, candidate.id, candidate.version, {
        csrfToken: readCsrfCredential(),
        idempotencyKey: crypto.randomUUID(),
      });
      await load();
      setMessage({ error: false, text: "Live integration preflight passed and the CA is active." });
    } catch (error) {
      setMessage(failure(error));
      setPending(false);
    }
  }

  return (
    <section className="integration-ca-console" aria-label="Private certificate authority">
      {items === undefined ? (
        <Button onClick={() => void load()} disabled={pending}>
          Load CA trust history
        </Button>
      ) : (
        <>
          <form className="collaboration-form" onSubmit={(event) => void stage(event)} aria-busy={pending}>
            <label className="field-group">
              PEM CA bundle
              <textarea
                name="pem"
                required
                maxLength={1_048_576}
                rows={5}
                spellCheck={false}
                disabled={pending}
              />
            </label>
            <p>
              Up to 1 MiB and 64 valid CA certificates. The saved integration supplies the endpoint; this form cannot
              override its host or port.
            </p>
            <Button disabled={pending}>Stage CA candidate</Button>
          </form>
          {items.length === 0 ? (
            <p>System trust is in use; no custom CA history exists.</p>
          ) : (
            <ul className="record-list">
              {items.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.state}</strong>
                    <span>
                      CA version {item.version} · expires {new Date(item.earliestExpiry).toLocaleDateString()}
                    </span>
                    <small>{item.fingerprints.join(", ")}</small>
                  </div>
                  {item.state === "candidate" ? (
                    <Button variant="primary" disabled={pending} onClick={() => void activate(item)}>
                      Preflight and activate
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {message ? <p role={message.error ? "alert" : "status"}>{message.text}</p> : null}
    </section>
  );
}

function failure(error: unknown) {
  if (error instanceof ApiError && (error.status === 403 || error.status === 428)) {
    return { error: true, text: "Administrator access and recent reauthentication are required." };
  }
  if (error instanceof ApiError && error.status === 412) {
    return { error: true, text: "CA state changed elsewhere. Reload the trust history before retrying." };
  }
  if (error instanceof ApiError && error.status === 422) {
    return { error: true, text: "The CA bundle or live integration preflight was rejected." };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { error: true, text: "Configure this integration before adding private CA trust." };
  }
  return { error: true, text: "CA trust could not be changed safely." };
}
