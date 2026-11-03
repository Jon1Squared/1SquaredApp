import React from 'react';
import { notFound } from 'next/navigation';
import { getAppSnapshot, getCurrentUserId } from '@/server/services';
import { MatterFormClient } from '@/components/MatterFormClient';

export const dynamic = 'force-dynamic';

export default async function EditMatterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getCurrentUserId();
  const snap = getAppSnapshot(userId);
  const matter = snap.matters.find((m) => m.id === id);
  if (!matter) notFound();

  return (
    <MatterFormClient
      existing={matter}
      activeViewingRole={snap.activeViewingRole}
      people={snap.people}
      organisations={snap.organisations}
      links={snap.links}
      matters={snap.matters}
      enquiries={snap.enquiries}
      lists={snap.lists}
      values={snap.values}
      customFields={snap.customFields}
      employees={snap.employees}
      currentUser={snap.currentUser}
      orgStructure={snap.orgStructure}
      matterPartyTaxonomy={snap.matterPartyTaxonomy}
      matterCostsConfig={snap.matterCostsConfig}
    />
  );
}
