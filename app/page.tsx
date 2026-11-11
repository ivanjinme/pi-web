import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";
import { startupSplashMarkup, startupSplashStyles } from "@/lib/startup-splash.mjs";

export default function Home() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: startupSplashStyles }} />
      <div id="startup-splash" role="status" aria-label="正在启动 Weclio" dangerouslySetInnerHTML={{ __html: startupSplashMarkup }} />
      <div id="startup-content" inert>
        <Suspense>
          <I18nProvider>
            <AppShell />
          </I18nProvider>
        </Suspense>
      </div>
    </>
  );
}
