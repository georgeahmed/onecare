import { useIntl } from 'react-intl';
import IntakeForm from '../components/IntakeForm';
import CallbackWindows from '../components/CallbackWindows';

const IntakePage = () => {
  const intl = useIntl();

  return (
    <main>
      <header>
        <h1>{intl.formatMessage({ id: 'app.title' })}</h1>
        <p>{intl.formatMessage({ id: 'app.description' })}</p>
        <CallbackWindows />
      </header>
      <IntakeForm />
    </main>
  );
};

export default IntakePage;
