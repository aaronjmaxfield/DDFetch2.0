import { Injectable } from '@angular/core';
import { QueryEngine, QueryInput, QueryResult } from './query-input.model';

/**
 * The queries DDFetch has always generated, ported verbatim out of
 * AppComponent so the old behaviour can be run side by side with v2.
 *
 * This is deliberately NOT cleaned up. Known defects are preserved exactly --
 * including the unscoped additional-service clause, the `*PROD*` wildcard that
 * also matches NONPROD, the silent Oregon DEV/CONFIG ACA drop, and the
 * additional-parameter tokeniser that discards a single quoted word. Its only
 * job is to reproduce what the tool did before. Fixes belong in v2.
 */
@Injectable({ providedIn: 'root' })
export class LegacyQueryBuilderService implements QueryEngine {
  readonly id = 'legacy' as const;
  readonly label = 'Legacy';

  build(input: QueryInput): QueryResult {
    const errors: string[] = [];
    const query = this.generateDatadogQuery(input, errors);
    return { query, warnings: [], errors };
  }

  /** Legacy setAdditionalParams(), preserved including the dropped-term bug. */
  formatAdditionalParams(raw: string): string {
    const terms = raw.split(' ');
    const formattedTerms: string[] = [];
    let withinQuotes = false;
    let currentTerm = '';

    for (const term of terms) {
      if (term.startsWith('"')) {
        withinQuotes = true;
        currentTerm = term;
      } else if (term.endsWith('"')) {
        withinQuotes = false;
        currentTerm += ' ' + term;
        formattedTerms.push(currentTerm);
      } else if (withinQuotes) {
        currentTerm += ' ' + term;
      } else {
        formattedTerms.push(`*${term}*`);
      }
    }

    return formattedTerms.join(' OR ');
  }

  private generateDatadogQuery(input: QueryInput, errors: string[]): string {
    const { servProvCode, host, environment, applications } = input;
    const upperServProvCode = servProvCode.toUpperCase();
    const lowerServProvCode = servProvCode.toLowerCase();
    const originalUpperEnv = environment.toUpperCase();
    let upperEnv = environment.toUpperCase();
    let lowerEnv = environment.toLowerCase();

    if (host === 'AU') {
      switch (originalUpperEnv) {
        case 'PROD': lowerEnv = 'auprod'; upperEnv = 'AUPROD'; break;
        case 'SUPP': lowerEnv = 'ausupp'; upperEnv = 'AUSUPP'; break;
        case 'TEST': lowerEnv = 'autest'; upperEnv = 'AUTEST'; break;
        case 'CONV': lowerEnv = 'auconv'; upperEnv = 'AUCONV'; break;
        case 'STG': lowerEnv = 'austg'; upperEnv = 'AUSTG'; break;
        case 'NONPROD1': lowerEnv = 'nonprod1'; upperEnv = 'NONPROD1'; break;
        case 'NONPROD2': lowerEnv = 'nonprod2'; upperEnv = 'NONPROD2'; break;
        case 'NONPROD3': lowerEnv = 'nonprod3'; upperEnv = 'NONPROD3'; break;
        case 'NONPROD4': lowerEnv = 'nonprod4'; upperEnv = 'NONPROD4'; break;
      }
    } else if (host === 'CA') {
      switch (originalUpperEnv) {
        case 'PROD': lowerEnv = 'prodca'; upperEnv = 'PRODCA'; break;
        case 'STG': lowerEnv = 'stgca'; upperEnv = 'STGCA'; break;
        case 'NONPROD1': lowerEnv = 'nonprod1'; upperEnv = 'NONPROD1'; break;
        case 'NONPROD2': lowerEnv = 'nonprod2'; upperEnv = 'NONPROD2'; break;
        case 'NONPROD3': lowerEnv = 'nonprod3'; upperEnv = 'NONPROD3'; break;
        case 'NONPROD4': lowerEnv = 'nonprod4'; upperEnv = 'NONPROD4'; break;
      }
    }

    const mainParts: string[] = [];
    const includesCivicPlatform =
      applications.includes('Civic Platform') || applications.includes('Citizen Access');
    const includesCitizenAccess = applications.includes('Citizen Access');

    if (includesCivicPlatform) {
      mainParts.push(`@SERV_PROV_CODE:*${upperServProvCode}*`);
      if (host !== 'OREGON') {
        mainParts.push(`@JNDI:*${lowerServProvCode}-${lowerEnv}*`);
        mainParts.push(`@JNDI:*${upperServProvCode}-${upperEnv}*`);
      }
    }
    if (includesCitizenAccess) {
      if (host === 'OREGON') {
        switch (originalUpperEnv) {
          case 'PROD':
            mainParts.push(`(*${upperServProvCode}* AND service:*aca*) OR filename:*${lowerServProvCode}-orprd-aca*`);
            break;
          case 'TRAIN':
            mainParts.push(`(*${upperServProvCode}* AND service:*aca*) OR filename:*oregon-oregon-train-aca*`);
            break;
          case 'CONFIG':
          case 'DEV':
            // Legacy dropped the ACA filter here with no user-visible signal.
            break;
          default:
            mainParts.push(`(*${upperServProvCode}* AND service:*aca*) OR filename:*${lowerServProvCode}-${lowerEnv}*`);
            break;
        }
      } else {
        mainParts.push(`(*${upperServProvCode}* AND service:*aca*) OR filename:*${lowerServProvCode}-${lowerEnv}*`);
      }
    }

    let hostFilter = '';
    if (host === 'US') {
      switch (originalUpperEnv) {
        case 'PROD': hostFilter = 'host:*mtprd*'; break;
        case 'TEST': case 'SUPP':
        case 'NONPROD1': case 'NONPROD2': case 'NONPROD3': case 'NONPROD4':
          hostFilter = 'host:*mtsup*'; break;
        case 'STG': hostFilter = 'host:*stg*'; break;
        case 'CVCN': hostFilter = 'host:*cvcn*'; break;
      }
    } else if (host === 'AU') {
      switch (originalUpperEnv) {
        case 'PROD': hostFilter = 'host:*auprd*'; break;
        case 'TEST': case 'SUPP':
        case 'NONPROD1': case 'NONPROD2': case 'NONPROD3': case 'NONPROD4':
          hostFilter = 'host:*ausup*'; break;
        case 'STG': hostFilter = 'host:*austg*'; break;
        case 'CONV': hostFilter = 'host:*auconv*'; break;
      }
    } else if (host === 'CA') {
      switch (originalUpperEnv) {
        case 'PROD': hostFilter = 'host:*caprd*'; break;
        case 'NONPROD1': case 'NONPROD2': case 'NONPROD3': case 'NONPROD4':
          hostFilter = 'host:*casup*'; break;
        case 'STG': hostFilter = 'host:*castg*'; break;
      }
    } else if (host === 'OREGON') {
      switch (originalUpperEnv) {
        case 'PROD': hostFilter = 'host:*orprd*'; break;
        case 'TRAIN': hostFilter = 'host:*ortest*'; break;
        case 'DEV': hostFilter = 'host:*ordev*'; break;
        case 'CONFIG': hostFilter = 'host:*orconf*'; break;
        case 'STG': hostFilter = 'host:*orstg*'; break;
      }
    }

    let mainQuery = '';
    if (mainParts.length === 1) {
      mainQuery = `(${mainParts[0]}) AND (${hostFilter})`;
    } else if (mainParts.length > 1) {
      mainQuery = `((${mainParts.join(' OR ')}) AND (${hostFilter}))`;
    }

    let capiQuery = '';
    if (applications.includes('CAPI')) {
      capiQuery = `(service:capi AND @Properties.log.EnvName:*${originalUpperEnv}* AND @Properties.log.Agency:*${upperServProvCode}*)`;
    }

    let additionalServicesQuery = '';
    const additionalServices = input.additionalServices;
    if (additionalServices.length > 0) {
      const serviceConditions: string[] = [];

      const paymentServices = additionalServices.filter(
        (s) => s === 'Forte' || s === 'Paypal Commerce'
      );
      if (paymentServices.length > 1) {
        errors.push('Please select only one payment service (Forte or Paypal Commerce)');
        return '';
      }

      const documentServices = additionalServices.filter((s) => s === 'ACDS' || s === 'ADS');
      if (documentServices.length > 1) {
        errors.push('Please select only one document service (ACDS or ADS)');
        return '';
      }

      additionalServices.forEach((service) => {
        switch (service) {
          case 'Forte':
            serviceConditions.push('service:payment-adapter-service', 'name:event-log-service', 'service:config-store-service');
            break;
          case 'Paypal Commerce':
            serviceConditions.push('service:payment-adapter-service', 'name:event-log-service', 'service:config-store-service', 'service:"Paypal UI"');
            break;
          case 'ACDS':
            serviceConditions.push('service:acds', 'service:edms-handler');
            break;
          case 'ADS':
            serviceConditions.push('service:av.ads');
            break;
        }
      });

      const uniqueConditions = [...new Set(serviceConditions)];
      if (uniqueConditions.length > 0) {
        additionalServicesQuery = `(${uniqueConditions.join(' OR ')})`;
      }
    }

    let query = '';
    const queryParts = [mainQuery, capiQuery, additionalServicesQuery].filter((p) => p !== '');
    if (queryParts.length > 1) {
      query = `(${queryParts.join(' OR ')})`;
    } else if (queryParts.length === 1) {
      query = queryParts[0];
    } else {
      query = '*';
    }

    const params = input.additionalParams.trim();
    if (params !== '') {
      query += ` (${this.formatAdditionalParams(params)})`;
    }

    return query;
  }
}
