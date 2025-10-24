import { useId } from 'react';
import { useIntl } from 'react-intl';
import useAuth from '../hooks/useAuth';

const ClinicSwitcher = () => {
  const { session, activeClinic, activeClinicId, setActiveClinic } = useAuth();
  const intl = useIntl();
  const selectId = useId();

  if (!session || session.clinics.length === 0) {
    return null;
  }

  if (session.clinics.length === 1) {
    return (
      <div className="clinic-indicator" role="status" aria-live="polite">
        <span className="clinic-indicator__label">
          {intl.formatMessage({ id: 'app.clinic.current' })}
        </span>
        <span className="clinic-indicator__value">{session.clinics[0].name}</span>
      </div>
    );
  }

  return (
    <div className="clinic-switcher">
      <label className="clinic-switcher__label" htmlFor={selectId}>
        {intl.formatMessage({ id: 'app.clinicSwitcher.label' })}
      </label>
      <select
        id={selectId}
        className="ui-select clinic-switcher__select"
        value={activeClinicId ?? activeClinic?.id ?? session.clinics[0].id}
        onChange={(event) => setActiveClinic(event.target.value)}
      >
        {session.clinics.map((clinic) => (
          <option key={clinic.id} value={clinic.id}>
            {clinic.name}
          </option>
        ))}
      </select>
    </div>
  );
};

export default ClinicSwitcher;
