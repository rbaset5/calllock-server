import pytest
from calllock.session import CallSession
from calllock.states import State
from calllock.state_machine import StateMachine


@pytest.fixture
def session():
    return CallSession(phone_number="+15125551234")


@pytest.fixture
def machine():
    return StateMachine()
