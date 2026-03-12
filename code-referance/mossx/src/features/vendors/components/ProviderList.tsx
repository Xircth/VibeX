import { useTranslation } from "react-i18next";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { ProviderConfig } from "../types";
import { LOCAL_SETTINGS_PROVIDER_ID } from "../types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ProviderListProps {
  providers: ProviderConfig[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (provider: ProviderConfig) => void;
  onDelete: (provider: ProviderConfig) => void;
  onSwitch: (id: string) => void;
}

export function ProviderList({
  providers,
  loading,
  onAdd,
  onEdit,
  onDelete,
  onSwitch,
}: ProviderListProps) {
  const { t } = useTranslation();
  const providerList = Array.isArray(providers) ? providers : [];
  const localProvider =
    providerList.find(
      (provider) =>
        provider.id === LOCAL_SETTINGS_PROVIDER_ID || provider.isLocalProvider,
    ) ?? null;
  const regularProviders = providerList.filter(
    (provider) =>
      provider.id !== LOCAL_SETTINGS_PROVIDER_ID && !provider.isLocalProvider,
  );

  return (
    <div className="vendor-provider-list">
      <div className="vendor-list-header">
        <span className="vendor-list-title">
          {t("settings.vendor.allProviders")}
        </span>
        <div className="vendor-list-actions">
          <Button size="sm" onClick={onAdd}>
            + {t("settings.vendor.add")}
          </Button>
        </div>
      </div>

      {loading && (
        <div className="vendor-loading">{t("settings.loading")}</div>
      )}

      <div className="vendor-cards">
        {localProvider && (
          <div
            className={cn(
              "vendor-card vendor-local-provider-card",
              localProvider.isActive && "active",
            )}
          >
            <div className="vendor-card-info">
              <div className="vendor-card-name vendor-local-provider-name">
                <FileText size={14} />
                {t("settings.vendor.localProviderName")}
              </div>
              <div
                className="vendor-card-remark"
                title={t("settings.vendor.localProviderDescription")}
              >
                {t("settings.vendor.localProviderDescription")}
              </div>
            </div>
            <div className="vendor-card-actions">
              {localProvider.isActive ? (
                <Badge variant="outline" className="text-stone-700 dark:text-stone-200">
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-emerald-500"
                  />
                  {t("settings.vendor.inUse")}
                </Badge>
              ) : (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => onSwitch(localProvider.id)}
                >
                  {t("settings.vendor.enable")}
                </Button>
              )}
            </div>
          </div>
        )}

        {regularProviders.map((provider) => (
          <div
            key={provider.id}
            className={cn(
              "vendor-card",
              provider.isActive && "active",
            )}
          >
            <div className="vendor-card-info">
              <div className="vendor-card-name">
                {provider.name}
                {provider.source === "cc-switch" && (
                  <Badge
                    variant="outline"
                    size="sm"
                    className="text-stone-600 dark:text-stone-300"
                  >
                    cc-switch
                  </Badge>
                )}
              </div>
              {(provider.remark || provider.websiteUrl) && (
                <div
                  className="vendor-card-remark"
                  title={provider.remark || provider.websiteUrl}
                >
                  {provider.remark || provider.websiteUrl}
                </div>
              )}
            </div>
            <div className="vendor-card-actions">
              {provider.isActive ? (
                <Badge variant="outline" className="text-stone-700 dark:text-stone-200">
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-emerald-500"
                  />
                  {t("settings.vendor.inUse")}
                </Badge>
              ) : (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => onSwitch(provider.id)}
                >
                  {t("settings.vendor.enable")}
                </Button>
              )}
              <span className="vendor-card-divider" />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onEdit(provider)}
                title={t("settings.vendor.edit")}
              >
                <Pencil aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="hover:text-destructive"
                onClick={() => onDelete(provider)}
                title={t("settings.vendor.delete")}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {!loading && regularProviders.length === 0 && !localProvider && (
        <div className="vendor-empty">
          {t("settings.vendor.emptyState")}
        </div>
      )}
    </div>
  );
}
