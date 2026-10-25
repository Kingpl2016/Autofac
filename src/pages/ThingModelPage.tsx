import { useTranslation } from "react-i18next";

import { PageHeader } from "@/shared/components/PageHeader";
import { Placeholder } from "@/shared/components/Placeholder";

export default function ThingModelPage() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={t("nav.thingModel")} />
      <Placeholder />
    </div>
  );
}
