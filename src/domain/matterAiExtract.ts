import type { ChoiceValue, Organisation, Person } from './types';
import { personDisplayName } from './names';
import { normaliseComparableName } from './normalise';

export interface IntakeSourceDocument {
  id: string;
  name: string;
  kind: 'email' | 'document' | 'note';
  mimeType?: string;
  sizeLabel?: string;
  content: string;
  base64Data?: string;
}

export interface CitedValue<T = string> {
  value: T;
  confidence: 'high' | 'medium' | 'low';
  sourceDoc: string;
  quote: string;
}

export interface ExtractedPartySuggestion {
  name: string;
  entityType: 'organisation' | 'person';
  relationshipCode: 'OP' | 'CP' | 'CO' | 'TP' | 'CC';
  capacityCodes: string[];
  roleDescription?: string;
  contactDetails?: string;
  address?: string;
  connectedToPartyName?: string;
  companyNumber?: string;
  town?: string;
  matchedRecordId?: string | null;
  matchedRecordName?: string | null;
  confidence: 'high' | 'medium' | 'low';
  sourceDoc: string;
  quote: string;
}

export interface ExtractedRiskSuggestion {
  questionId: string;
  answer: string;
  followUp?: string;
  confidence: 'high' | 'medium' | 'low';
  sourceDoc: string;
  quote: string;
}

export interface ExtractedKeyDateSuggestion {
  label: string;
  date: string;
  critical?: boolean;
  sourceDoc: string;
  quote: string;
}

export interface ExtractedAcasDetails {
  certificate: string;
  dayA?: string;
  dayB?: string;
  sourceDoc?: string;
}

export interface ExtractedFundingDetails {
  type: string;
  insurer?: string;
  policyNumber?: string;
  excess?: string;
  insurerRef?: string;
  poNumber?: string;
  feeEstimate?: string;
  sourceDoc?: string;
}

export interface ExtractedBillingDetails {
  invoiceEntity?: string;
  invoiceAddress?: string;
  invoiceEmail?: string;
  poNumber?: string;
  budgetSummary?: string;
  paymentTerms?: string;
  billingBasis?: string;
  feeEstimateGbp?: string;
  agreedFeeCapGbp?: string;
  retainerMoniesOnAccountGbp?: string;
  sourceDoc?: string;
}

export interface ExtractedMatterOption {
  matterRef: string;
  title: CitedValue | null;
  practiceArea: {
    label: string;
    matchedId?: string | null;
    confidence: 'high' | 'medium' | 'low';
    sourceDoc: string;
    quote: string;
  } | null;
  workType: {
    label: string;
    subTypeDetail?: string;
    matchedId?: string | null;
    confidence: 'high' | 'medium' | 'low';
    sourceDoc: string;
    quote: string;
  } | null;
  clientRole?: string;
  clientCapacityCode: CitedValue | null;
  shortDescription: CitedValue | null;
  responsiblePartner: {
    name: string;
    matchedPersonId?: string | null;
    sourceDoc: string;
    quote: string;
  } | null;
  leadFeeEarner: {
    name: string;
    matchedPersonId?: string | null;
    sourceDoc: string;
    quote: string;
  } | null;
  forumCourt: CitedValue | null;
  caseNumber: CitedValue | null;
  claimValue: CitedValue | null;
  acasEc: ExtractedAcasDetails | null;
  funding: ExtractedFundingDetails | null;
  confidentiality: CitedValue | null;
  clientReference: CitedValue | null;
  feeEstimateGbp: CitedValue | null;
  agreedFeeCapGbp: CitedValue | null;
  retainerMoniesOnAccountGbp: CitedValue | null;
  targetCompletionAt: CitedValue | null;
  otherParties: ExtractedPartySuggestion[];
  keyDates: ExtractedKeyDateSuggestion[];
  riskSuggestions: ExtractedRiskSuggestion[];
}

export interface MatterAiExtractionResult {
  engine: 'claude';
  modelName: string;
  summary: string;
  extractedAt: string;
  // Section 1: Matter details & team
  client: {
    name: string;
    entityType: 'organisation' | 'person';
    companyNumber?: string;
    registeredOffice?: string;
    tradingAddress?: string;
    existingClientNote?: string;
    town?: string;
    postcode?: string;
    addressLine1?: string;
    email?: string;
    phone?: string;
    matchedRecordId?: string | null;
    matchedRecordName?: string | null;
    createdNewRecord?: boolean;
    confidence: 'high' | 'medium' | 'low';
    sourceDoc: string;
    quote: string;
  } | null;
  instructingContact: {
    name: string;
    email?: string;
    phone?: string;
    mobile?: string;
    jobTitle?: string;
    matchedPersonId?: string | null;
    matchedPersonName?: string | null;
    createdNewRecord?: boolean;
    confidence: 'high' | 'medium' | 'low';
    sourceDoc: string;
    quote: string;
  } | null;
  billingContact?: {
    name: string;
    email?: string;
    phone?: string;
    jobTitle?: string;
    matchedPersonId?: string | null;
    matchedPersonName?: string | null;
    createdNewRecord?: boolean;
    confidence: 'high' | 'medium' | 'low';
    sourceDoc: string;
    quote: string;
  } | null;
  billing?: ExtractedBillingDetails | null;
  title: CitedValue | null;
  practiceArea: {
    label: string;
    matchedId?: string | null;
    confidence: 'high' | 'medium' | 'low';
    sourceDoc: string;
    quote: string;
  } | null;
  workType: {
    label: string;
    subTypeDetail?: string;
    matchedId?: string | null;
    confidence: 'high' | 'medium' | 'low';
    sourceDoc: string;
    quote: string;
  } | null;
  clientRole?: string;
  responsiblePartner: {
    name: string;
    matchedPersonId?: string | null;
    sourceDoc: string;
    quote: string;
  } | null;
  leadFeeEarner: {
    name: string;
    matchedPersonId?: string | null;
    sourceDoc: string;
    quote: string;
  } | null;
  // Section 2: Matter risk assessment
  riskSuggestions: ExtractedRiskSuggestion[];
  keyDates: ExtractedKeyDateSuggestion[];
  // Section 3: Matter parties
  clientCapacityCode: CitedValue | null;
  otherParties: ExtractedPartySuggestion[];
  // Section 6: More details
  shortDescription: CitedValue | null;
  feeEstimateGbp: CitedValue | null;
  agreedFeeCapGbp: CitedValue | null;
  retainerMoniesOnAccountGbp: CitedValue | null;
  targetCompletionAt: CitedValue | null;
  clientReference: CitedValue | null;
  claimValue: CitedValue | null;
  forumCourt: CitedValue | null;
  caseNumber?: CitedValue | null;
  acasEc?: ExtractedAcasDetails | null;
  funding?: ExtractedFundingDetails | null;
  confidentiality?: CitedValue | null;
  // Multi-matter support when a document pack contains more than one instruction (e.g. Matter A and Matter B)
  matters?: ExtractedMatterOption[];
}

function safeNorm(val?: string | null): string {
  if (!val || typeof val !== 'string') return '';
  return normaliseComparableName(val);
}

function matchPracticeAreaAndWorkType(
  paInput: {
    label: string;
    matchedId?: string | null;
    confidence: 'high' | 'medium' | 'low';
    sourceDoc: string;
    quote: string;
  } | null,
  wtInput: {
    label: string;
    subTypeDetail?: string;
    matchedId?: string | null;
    confidence: 'high' | 'medium' | 'low';
    sourceDoc: string;
    quote: string;
  } | null,
  values: ChoiceValue[],
) {
  const practiceAreas = values.filter(
    (v) => v.listKey === 'work_type' && !v.parentId && v.active && v.label,
  );

  let practiceArea = paInput ? { ...paInput } : null;
  let workType = wtInput ? { ...wtInput } : null;

  const paLabelRaw =
    practiceArea?.label ||
    (practiceArea as unknown as { value?: string } | null)?.value ||
    '';

  if (practiceArea && paLabelRaw) {
    practiceArea.label = paLabelRaw;
    const q = paLabelRaw.toLowerCase();
    const matchedPa =
      practiceAreas.find((p) => p.label.toLowerCase() === q) ??
      practiceAreas.find(
        (p) => p.label.toLowerCase().includes(q) || q.includes(p.label.toLowerCase()),
      ) ??
      practiceAreas.find((p) => {
        if (q.includes('employ') && p.label.toLowerCase().includes('employment')) return true;
        if (
          (q.includes('property') || q.includes('real estate') || q.includes('conveyanc')) &&
          p.label.toLowerCase().includes('real estate')
        )
          return true;
        if (
          (q.includes('litigation') || q.includes('dispute')) &&
          p.label.toLowerCase().includes('dispute')
        )
          return true;
        if (
          (q.includes('corporate') || q.includes('commercial')) &&
          p.label.toLowerCase().includes('corporate')
        )
          return true;
        return false;
      });
    if (matchedPa) {
      practiceArea.matchedId = matchedPa.id;
      practiceArea.label = matchedPa.label;
    }
  } else {
    practiceArea = null;
  }

  const wtLabelRaw =
    workType?.label ||
    (workType as unknown as { value?: string } | null)?.value ||
    '';

  if (workType && wtLabelRaw) {
    if (!workType.subTypeDetail) {
      workType.subTypeDetail = wtLabelRaw;
    }
    const q = `${wtLabelRaw} ${workType.subTypeDetail || ''}`.toLowerCase();
    const subcats = values.filter(
      (v) =>
        v.listKey === 'work_type' &&
        Boolean(v.parentId) &&
        v.active &&
        Boolean(v.label) &&
        (!practiceArea?.matchedId || v.parentId === practiceArea.matchedId),
    );
    const allSubcats = values.filter(
      (v) => v.listKey === 'work_type' && Boolean(v.parentId) && v.active && Boolean(v.label),
    );
    const pool = subcats.length > 0 ? subcats : allSubcats;

    const matchedSub =
      pool.find((s) => s.label.toLowerCase() === wtLabelRaw.toLowerCase()) ??
      pool.find(
        (s) =>
          s.label.toLowerCase().includes(wtLabelRaw.toLowerCase()) ||
          wtLabelRaw.toLowerCase().includes(s.label.toLowerCase()),
      ) ??
      pool.find((s) => {
        const sl = s.label.toLowerCase();
        if (
          (q.includes('tribunal') ||
            q.includes('et1') ||
            q.includes('et3') ||
            q.includes('unfair dismissal') ||
            q.includes('discrimination')) &&
          sl.includes('tribunal')
        ) {
          return true;
        }
        if (
          (q.includes('redundan') || q.includes('restructur') || q.includes('consultation')) &&
          sl.includes('redundancy')
        ) {
          return true;
        }
        if (q.includes('tupe') && sl.includes('tupe')) return true;
        if ((q.includes('disciplinary') || q.includes('grievance')) && sl.includes('disciplinary'))
          return true;
        if (q.includes('settlement') && sl.includes('settlement')) return true;
        if ((q.includes('handbook') || q.includes('policy')) && sl.includes('policies'))
          return true;
        if ((q.includes('lease') || q.includes('landlord') || q.includes('tenant')) && sl.includes('landlord'))
          return true;
        if ((q.includes('acqui') || q.includes('disposal') || q.includes('purchase') || q.includes('sale')) && sl.includes('acquisition'))
          return true;
        if ((q.includes('contract') || q.includes('commercial')) && sl.includes('contract'))
          return true;
        return false;
      });

    if (matchedSub) {
      workType.matchedId = matchedSub.id;
      workType.label = matchedSub.label;
      if (!practiceArea?.matchedId && matchedSub.parentId) {
        const parentPa = practiceAreas.find((p) => p.id === matchedSub.parentId);
        if (parentPa) {
          practiceArea = {
            label: parentPa.label,
            matchedId: parentPa.id,
            confidence: 'high',
            sourceDoc: workType.sourceDoc || '',
            quote: workType.quote || '',
          };
        }
      }
    }
  } else {
    workType = null;
  }

  return { practiceArea, workType };
}

/**
 * Matches extracted text names against CRM Organisations, People, Employees, and Work Types.
 */
export function enrichExtractionWithCrmMatches(
  raw: MatterAiExtractionResult,
  context: {
    organisations: Organisation[];
    people: Person[];
    employees: Person[];
    values: ChoiceValue[];
  },
): MatterAiExtractionResult {
  const result: MatterAiExtractionResult = structuredClone(raw);

  const findOrg = (name?: string, companyNo?: string): Organisation | undefined => {
    if (!name && !companyNo) return undefined;
    const cleanCo = typeof companyNo === 'string' ? companyNo.trim().toLowerCase() : '';
    if (cleanCo) {
      const byCo = context.organisations.find(
        (o) =>
          typeof o.companyNumber === 'string' &&
          o.companyNumber.trim().toLowerCase() === cleanCo,
      );
      if (byCo) return byCo;
    }
    const norm = safeNorm(name);
    if (!norm) return undefined;
    return context.organisations.find((o) => {
      const oNorm = safeNorm(o.legalName);
      return Boolean(oNorm && (oNorm === norm || oNorm.includes(norm) || norm.includes(oNorm)));
    });
  };

  const findPerson = (name?: string, emailAddr?: string): Person | undefined => {
    const cleanEmail = typeof emailAddr === 'string' ? emailAddr.trim().toLowerCase() : '';
    if (cleanEmail) {
      const byEmail = context.people.find((p) =>
        p.emails?.some((e) => e.address?.toLowerCase() === cleanEmail),
      );
      if (byEmail) return byEmail;
    }
    const norm = safeNorm(name);
    if (!norm) return undefined;
    return context.people.find((p) => {
      const pNorm = safeNorm(personDisplayName(p));
      return Boolean(pNorm && (pNorm === norm || pNorm.includes(norm) || norm.includes(pNorm)));
    });
  };

  const findEmployee = (rawName?: string): Person | undefined => {
    if (!rawName || typeof rawName !== 'string') return undefined;
    // Strip role parentheticals like "(Partner)" or "(Senior Associate)"
    const cleaned = rawName.replace(/\([^)]*\)/g, '').trim();
    const targetNorm = safeNorm(cleaned);
    if (!targetNorm) return undefined;
    return context.employees.find((e) => {
      const eNorm = safeNorm(personDisplayName(e));
      return Boolean(eNorm && (eNorm === targetNorm || eNorm.includes(targetNorm) || targetNorm.includes(eNorm)));
    });
  };

  // Match client
  if (result.client && result.client.name) {
    if (result.client.entityType === 'organisation') {
      const org = findOrg(result.client.name, result.client.companyNumber);
      if (org) {
        result.client.matchedRecordId = org.id;
        result.client.matchedRecordName = org.legalName;
        if (!result.client.companyNumber && org.companyNumber) {
          result.client.companyNumber = org.companyNumber;
        }
      }
    } else {
      const per = findPerson(result.client.name, result.client.email);
      if (per) {
        result.client.matchedRecordId = per.id;
        result.client.matchedRecordName = personDisplayName(per);
      }
    }
  } else {
    result.client = null;
  }

  // Match instructing contact
  if (result.instructingContact && result.instructingContact.name) {
    const per = findPerson(
      result.instructingContact.name,
      result.instructingContact.email,
    );
    if (per) {
      result.instructingContact.matchedPersonId = per.id;
      result.instructingContact.matchedPersonName = personDisplayName(per);
    }
  } else {
    result.instructingContact = null;
  }

  // Match billing contact
  if (result.billingContact && result.billingContact.name) {
    const per = findPerson(
      result.billingContact.name,
      result.billingContact.email,
    );
    if (per) {
      result.billingContact.matchedPersonId = per.id;
      result.billingContact.matchedPersonName = personDisplayName(per);
    }
  } else {
    result.billingContact = null;
  }

  const enrichPartyList = (parties: ExtractedPartySuggestion[]): ExtractedPartySuggestion[] => {
    return (Array.isArray(parties) ? parties : [])
      .filter((pt) => Boolean(pt && typeof pt.name === 'string' && pt.name.trim()))
      .map((pt) => {
        const entityType = pt.entityType === 'person' ? 'person' : 'organisation';
        const relCode = ['OP', 'CP', 'CO', 'TP', 'CC'].includes(pt.relationshipCode)
          ? pt.relationshipCode
          : 'OP';
        const capCodes = Array.isArray(pt.capacityCodes)
          ? pt.capacityCodes.filter((c): c is string => typeof c === 'string')
          : [];
        if (entityType === 'organisation') {
          const org = findOrg(pt.name, pt.companyNumber);
          if (org) {
            return {
              ...pt,
              entityType,
              relationshipCode: relCode,
              capacityCodes: capCodes,
              matchedRecordId: org.id,
              matchedRecordName: org.legalName,
              companyNumber: pt.companyNumber || org.companyNumber || undefined,
              town: pt.town || org.registeredAddress?.town || undefined,
            };
          }
        } else {
          const per = findPerson(pt.name);
          if (per) {
            return {
              ...pt,
              entityType,
              relationshipCode: relCode,
              capacityCodes: capCodes,
              matchedRecordId: per.id,
              matchedRecordName: personDisplayName(per),
              town: pt.town || per.addresses?.[0]?.town || undefined,
            };
          }
        }
        return {
          ...pt,
          entityType,
          relationshipCode: relCode,
          capacityCodes: capCodes,
        };
      });
  };

  // Match Practice Area & Work Type on top-level
  const matchedTop = matchPracticeAreaAndWorkType(
    result.practiceArea,
    result.workType,
    context.values,
  );
  result.practiceArea = matchedTop.practiceArea;
  result.workType = matchedTop.workType;

  // Match Responsible Partner & Fee Earner on top-level
  if (result.responsiblePartner && result.responsiblePartner.name) {
    const emp = findEmployee(result.responsiblePartner.name);
    if (emp) {
      result.responsiblePartner.matchedPersonId = emp.id;
      result.responsiblePartner.name = personDisplayName(emp);
    }
  } else {
    result.responsiblePartner = null;
  }

  if (result.leadFeeEarner && result.leadFeeEarner.name) {
    const emp = findEmployee(result.leadFeeEarner.name);
    if (emp) {
      result.leadFeeEarner.matchedPersonId = emp.id;
      result.leadFeeEarner.name = personDisplayName(emp);
    }
  } else {
    result.leadFeeEarner = null;
  }

  result.otherParties = enrichPartyList(result.otherParties);

  result.riskSuggestions = (
    Array.isArray(result.riskSuggestions) ? result.riskSuggestions : []
  ).filter(
    (r) =>
      Boolean(
        r &&
          typeof r.questionId === 'string' &&
          typeof r.answer === 'string' &&
          r.questionId.trim() &&
          r.answer.trim(),
      ),
  );

  result.keyDates = (Array.isArray(result.keyDates) ? result.keyDates : []).filter((kd) =>
    Boolean(kd && typeof kd.date === 'string' && kd.date.trim()),
  );

  // Also enrich each matter option in result.matters if present
  if (Array.isArray(result.matters) && result.matters.length > 0) {
    result.matters = result.matters.map((m) => {
      const mMatched = matchPracticeAreaAndWorkType(
        m.practiceArea,
        m.workType,
        context.values,
      );
      let respPartner = m.responsiblePartner ? { ...m.responsiblePartner } : null;
      if (respPartner?.name) {
        const emp = findEmployee(respPartner.name);
        if (emp) {
          respPartner.matchedPersonId = emp.id;
          respPartner.name = personDisplayName(emp);
        }
      } else {
        respPartner = null;
      }

      let leadFe = m.leadFeeEarner ? { ...m.leadFeeEarner } : null;
      if (leadFe?.name) {
        const emp = findEmployee(leadFe.name);
        if (emp) {
          leadFe.matchedPersonId = emp.id;
          leadFe.name = personDisplayName(emp);
        }
      } else {
        leadFe = null;
      }

      return {
        ...m,
        practiceArea: mMatched.practiceArea,
        workType: mMatched.workType,
        responsiblePartner: respPartner,
        leadFeeEarner: leadFe,
        otherParties: enrichPartyList(m.otherParties),
        riskSuggestions: (Array.isArray(m.riskSuggestions) ? m.riskSuggestions : []).filter(
          (r) =>
            Boolean(
              r &&
                typeof r.questionId === 'string' &&
                typeof r.answer === 'string' &&
                r.questionId.trim() &&
                r.answer.trim(),
            ),
        ),
        keyDates: (Array.isArray(m.keyDates) ? m.keyDates : []).filter((kd) =>
          Boolean(kd && typeof kd.date === 'string' && kd.date.trim()),
        ),
      };
    });
  }

  return result;
}
